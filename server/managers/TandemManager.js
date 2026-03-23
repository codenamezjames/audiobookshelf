const uuidv4 = require('uuid').v4
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')

/**
 * @typedef TandemMember
 * @property {string} userId
 * @property {string} socketId
 * @property {string} username
 * @property {number} lastPing
 * @property {number} latency estimated one-way latency in ms
 */

/**
 * @typedef TandemSession
 * @property {string} id
 * @property {string} libraryItemId
 * @property {string} episodeId
 * @property {string} displayTitle
 * @property {string} hostUserId
 * @property {Map<string, TandemMember>} members keyed by userId
 * @property {number} canonicalPosition current position in seconds
 * @property {number} canonicalTimestamp server Date.now() when position was recorded
 * @property {boolean} isPaused
 * @property {number} playbackSpeed
 * @property {number} createdAt
 */

class TandemManager {
  constructor() {
    /** @type {Map<string, TandemSession>} */
    this.sessions = new Map()

    /** @type {Map<string, string>} userId → sessionId for quick lookup */
    this.userSessionMap = new Map()

    /** @type {Map<string, { id: string, fromUserId: string, fromUsername: string, toUserId: string, libraryItemId: string, episodeId: string, displayTitle: string, createdAt: number }>} */
    this.pendingInvites = new Map()

    // Broadcast canonical state every 3 seconds
    this.broadcastInterval = setInterval(() => this.broadcastAllSessions(), 3000)
  }

  /**
   * Get active session for a user
   * @param {string} userId
   * @returns {TandemSession|null}
   */
  getSessionForUser(userId) {
    const sessionId = this.userSessionMap.get(userId)
    if (!sessionId) return null
    return this.sessions.get(sessionId) || null
  }

  /**
   * Create a tandem session and add the host
   * @param {string} userId
   * @param {string} socketId
   * @param {string} username
   * @param {string} libraryItemId
   * @param {string|null} episodeId
   * @param {string} displayTitle
   * @param {number} currentPosition position in seconds
   * @param {number} playbackSpeed
   * @returns {TandemSession}
   */
  createSession(userId, socketId, username, libraryItemId, episodeId, displayTitle, currentPosition, playbackSpeed) {
    // Leave any existing session first
    this.leaveSession(userId)

    const session = {
      id: uuidv4(),
      libraryItemId,
      episodeId: episodeId || null,
      displayTitle,
      hostUserId: userId,
      members: new Map(),
      canonicalPosition: currentPosition || 0,
      canonicalTimestamp: Date.now(),
      isPaused: true,
      playbackSpeed: playbackSpeed || 1,
      createdAt: Date.now()
    }

    session.members.set(userId, {
      userId,
      socketId,
      username,
      lastPing: Date.now(),
      latency: 0
    })

    this.sessions.set(session.id, session)
    this.userSessionMap.set(userId, session.id)

    // Join Socket.IO room for efficient broadcasting
    const socket = SocketAuthority.clients[socketId]?.socket
    if (socket) {
      socket.join(`tandem:${session.id}`)
    }

    Logger.info(`[TandemManager] Session "${session.id}" created by "${username}" for "${displayTitle}"`)
    return session
  }

  /**
   * Add a user to an existing session
   * @param {string} sessionId
   * @param {string} userId
   * @param {string} socketId
   * @param {string} username
   * @returns {TandemSession|null}
   */
  joinSession(sessionId, userId, socketId, username) {
    const session = this.sessions.get(sessionId)
    if (!session) {
      Logger.warn(`[TandemManager] joinSession: Session "${sessionId}" not found`)
      return null
    }

    // Leave any existing session first
    this.leaveSession(userId)

    session.members.set(userId, {
      userId,
      socketId,
      username,
      lastPing: Date.now(),
      latency: 0
    })

    this.userSessionMap.set(userId, sessionId)

    // Join Socket.IO room
    const socket = SocketAuthority.clients[socketId]?.socket
    if (socket) {
      socket.join(`tandem:${session.id}`)
    }

    // Pause when new member joins so they can sync
    session.isPaused = true
    this.updateCanonicalPosition(session)

    Logger.info(`[TandemManager] User "${username}" joined session "${sessionId}"`)

    // Notify all members
    this.emitToSession(session, 'tandem_joined', {
      sessionId: session.id,
      userId,
      username,
      members: this.getMembersArray(session)
    })

    return session
  }

  /**
   * Remove a user from their active session
   * @param {string} userId
   * @returns {boolean}
   */
  leaveSession(userId) {
    const sessionId = this.userSessionMap.get(userId)
    if (!sessionId) return false

    const session = this.sessions.get(sessionId)
    if (!session) {
      this.userSessionMap.delete(userId)
      return false
    }

    const member = session.members.get(userId)
    if (member) {
      // Leave Socket.IO room
      const socket = SocketAuthority.clients[member.socketId]?.socket
      if (socket) {
        socket.leave(`tandem:${session.id}`)
      }
    }

    session.members.delete(userId)
    this.userSessionMap.delete(userId)

    Logger.info(`[TandemManager] User "${member?.username || userId}" left session "${sessionId}"`)

    if (session.members.size === 0) {
      // Last member left — destroy session
      this.destroySession(sessionId)
    } else {
      // Pause playback when someone leaves
      session.isPaused = true
      this.updateCanonicalPosition(session)

      // Notify remaining members
      this.emitToSession(session, 'tandem_left', {
        sessionId: session.id,
        userId,
        members: this.getMembersArray(session)
      })
    }

    return true
  }

  /**
   * Handle a playback action from any member (play, pause, seek, speed)
   * @param {string} userId
   * @param {{ action: string, position?: number, playbackSpeed?: number, timestamp?: number }} actionData
   */
  syncAction(userId, actionData) {
    const session = this.getSessionForUser(userId)
    if (!session) return

    const member = session.members.get(userId)
    if (!member) return

    this.updateCanonicalPosition(session)

    switch (actionData.action) {
      case 'play':
        session.isPaused = false
        session.canonicalTimestamp = Date.now()
        break
      case 'pause':
        session.isPaused = true
        break
      case 'seek':
        if (typeof actionData.position === 'number') {
          session.canonicalPosition = actionData.position
          session.canonicalTimestamp = Date.now()
        }
        break
      case 'speed':
        if (typeof actionData.playbackSpeed === 'number' && actionData.playbackSpeed > 0) {
          session.playbackSpeed = actionData.playbackSpeed
          session.canonicalTimestamp = Date.now()
        }
        break
      default:
        Logger.warn(`[TandemManager] Unknown action "${actionData.action}" from user "${userId}"`)
        return
    }

    // Broadcast immediately (don't wait for the 3s tick)
    this.broadcastSessionState(session, `action:${actionData.action}`)
  }

  /**
   * Handle ping from a client for latency estimation
   * @param {string} userId
   * @param {string} socketId
   * @param {number} clientTimestamp
   */
  handlePing(userId, socketId, clientTimestamp) {
    const session = this.getSessionForUser(userId)
    if (!session) return

    const member = session.members.get(userId)
    if (member) {
      member.lastPing = Date.now()
    }

    const socket = SocketAuthority.clients[socketId]?.socket
    if (socket) {
      socket.emit('tandem_pong', {
        clientTimestamp,
        serverTimestamp: Date.now()
      })
    }
  }

  /**
   * Create an invite for another user
   * @param {string} fromUserId
   * @param {string} fromUsername
   * @param {string} toUserId
   * @param {string} libraryItemId
   * @param {string|null} episodeId
   * @param {string} displayTitle
   * @param {number} currentPosition
   * @param {number} playbackSpeed
   * @returns {{ inviteId: string, session: TandemSession }|null}
   */
  createInvite(fromUserId, fromUsername, toUserId, libraryItemId, episodeId, displayTitle, currentPosition, playbackSpeed) {
    // Check if target user is already in a session
    if (this.userSessionMap.has(toUserId)) {
      Logger.warn(`[TandemManager] Cannot invite user "${toUserId}" — already in a session`)
      return null
    }

    // Create session if host doesn't have one already for this item
    let session = this.getSessionForUser(fromUserId)
    if (!session || session.libraryItemId !== libraryItemId) {
      const fromClient = this.getClientForUser(fromUserId)
      if (!fromClient) return null
      session = this.createSession(fromUserId, fromClient.id, fromUsername, libraryItemId, episodeId, displayTitle, currentPosition, playbackSpeed)
    }

    const inviteId = uuidv4()
    this.pendingInvites.set(inviteId, {
      id: inviteId,
      fromUserId,
      fromUsername,
      toUserId,
      libraryItemId,
      episodeId: episodeId || null,
      displayTitle,
      sessionId: session.id,
      createdAt: Date.now()
    })

    // Auto-expire invites after 60 seconds
    setTimeout(() => {
      if (this.pendingInvites.has(inviteId)) {
        this.pendingInvites.delete(inviteId)
        Logger.debug(`[TandemManager] Invite "${inviteId}" expired`)
      }
    }, 60000)

    // Send invite to target user via Socket.IO
    SocketAuthority.clientEmitter(toUserId, 'tandem_invite', {
      inviteId,
      fromUserId,
      fromUsername,
      libraryItemId,
      episodeId: episodeId || null,
      displayTitle,
      sessionId: session.id
    })

    Logger.info(`[TandemManager] Invite sent from "${fromUsername}" to user "${toUserId}" for "${displayTitle}"`)
    return { inviteId, session }
  }

  /**
   * Handle invite response (accept/decline)
   * @param {string} inviteId
   * @param {string} userId
   * @param {string} socketId
   * @param {string} username
   * @param {boolean} accepted
   * @returns {TandemSession|null}
   */
  respondToInvite(inviteId, userId, socketId, username, accepted) {
    const invite = this.pendingInvites.get(inviteId)
    if (!invite) {
      Logger.warn(`[TandemManager] Invite "${inviteId}" not found or expired`)
      return null
    }

    if (invite.toUserId !== userId) {
      Logger.warn(`[TandemManager] User "${userId}" is not the target of invite "${inviteId}"`)
      return null
    }

    this.pendingInvites.delete(inviteId)

    if (!accepted) {
      // Notify the host that invite was declined
      SocketAuthority.clientEmitter(invite.fromUserId, 'tandem_invite_declined', {
        inviteId,
        userId,
        username
      })
      Logger.info(`[TandemManager] User "${username}" declined invite from "${invite.fromUsername}"`)
      return null
    }

    // Accept — join the session
    const session = this.joinSession(invite.sessionId, userId, socketId, username)
    return session
  }

  /**
   * Handle socket disconnect — remove user from any active session
   * @param {string} socketId
   * @param {string} userId
   */
  handleDisconnect(socketId, userId) {
    if (!userId) return
    const session = this.getSessionForUser(userId)
    if (!session) return

    const member = session.members.get(userId)
    if (member && member.socketId === socketId) {
      Logger.info(`[TandemManager] Socket disconnect for user "${member.username}" — leaving session`)
      this.leaveSession(userId)
    }
  }

  // ---- Internal helpers ----

  /**
   * Snapshot the canonical position based on elapsed time since last update
   * @param {TandemSession} session
   */
  updateCanonicalPosition(session) {
    if (!session.isPaused) {
      const elapsed = (Date.now() - session.canonicalTimestamp) / 1000
      session.canonicalPosition += elapsed * session.playbackSpeed
    }
    session.canonicalTimestamp = Date.now()
  }

  /**
   * Broadcast state for a single session
   * @param {TandemSession} session
   * @param {string} [trigger]
   */
  broadcastSessionState(session, trigger) {
    this.updateCanonicalPosition(session)

    const state = {
      sessionId: session.id,
      position: session.canonicalPosition,
      timestamp: session.canonicalTimestamp,
      isPaused: session.isPaused,
      playbackSpeed: session.playbackSpeed,
      members: this.getMembersArray(session),
      trigger: trigger || 'tick'
    }

    this.emitToSession(session, 'tandem_state', state)
  }

  /**
   * Periodic broadcast for all active sessions
   */
  broadcastAllSessions() {
    for (const session of this.sessions.values()) {
      this.broadcastSessionState(session)
    }
  }

  /**
   * Emit an event to all members of a session using Socket.IO rooms
   * @param {TandemSession} session
   * @param {string} event
   * @param {*} data
   */
  emitToSession(session, event, data) {
    // Use Socket.IO rooms for efficient broadcasting
    for (const ioServer of SocketAuthority.socketIoServers) {
      ioServer.to(`tandem:${session.id}`).emit(event, data)
    }
  }

  /**
   * Get members as a plain array for serialization
   * @param {TandemSession} session
   * @returns {Array<{ userId: string, username: string }>}
   */
  getMembersArray(session) {
    return Array.from(session.members.values()).map((m) => ({
      userId: m.userId,
      username: m.username
    }))
  }

  /**
   * Get the first connected socket client for a user
   * @param {string} userId
   * @returns {import('../SocketAuthority').SocketClient|null}
   */
  getClientForUser(userId) {
    const clients = SocketAuthority.getClientsForUser(userId)
    return clients.length ? clients[0] : null
  }

  /**
   * Destroy a session and clean up
   * @param {string} sessionId
   */
  destroySession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Remove all member mappings
    for (const userId of session.members.keys()) {
      this.userSessionMap.delete(userId)
    }

    // Notify any remaining connected members
    this.emitToSession(session, 'tandem_ended', { sessionId })

    this.sessions.delete(sessionId)
    Logger.info(`[TandemManager] Session "${sessionId}" destroyed`)
  }

  /**
   * Get session state as JSON for REST API
   * @param {TandemSession} session
   * @returns {Object}
   */
  sessionToJSON(session) {
    this.updateCanonicalPosition(session)
    return {
      id: session.id,
      libraryItemId: session.libraryItemId,
      episodeId: session.episodeId,
      displayTitle: session.displayTitle,
      hostUserId: session.hostUserId,
      members: this.getMembersArray(session),
      position: session.canonicalPosition,
      isPaused: session.isPaused,
      playbackSpeed: session.playbackSpeed,
      createdAt: session.createdAt
    }
  }

  /**
   * Clean up on server shutdown
   */
  close() {
    clearInterval(this.broadcastInterval)
    this.sessions.clear()
    this.userSessionMap.clear()
    this.pendingInvites.clear()
    Logger.info('[TandemManager] Closed')
  }
}

module.exports = TandemManager
