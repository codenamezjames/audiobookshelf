const Logger = require('../Logger')

class TandemController {
  constructor() {}

  /**
   * POST /api/tandem/invite
   * Send a tandem invite to another user
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async invite(req, res) {
    const { toUserId, libraryItemId, episodeId, displayTitle, currentPosition, playbackSpeed } = req.body
    if (!toUserId || !libraryItemId) {
      return res.status(400).json({ error: 'toUserId and libraryItemId are required' })
    }

    const result = this.tandemManager.createInvite(
      req.user.id,
      req.user.username,
      toUserId,
      libraryItemId,
      episodeId || null,
      displayTitle || '',
      currentPosition || 0,
      playbackSpeed || 1
    )

    if (!result) {
      return res.status(400).json({ error: 'Could not create invite. Target user may already be in a session.' })
    }

    res.json({
      inviteId: result.inviteId,
      session: this.tandemManager.sessionToJSON(result.session)
    })
  }

  /**
   * POST /api/tandem/:id/leave
   * Leave a tandem session
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async leave(req, res) {
    const left = this.tandemManager.leaveSession(req.user.id)
    if (!left) {
      return res.status(404).json({ error: 'Not in a tandem session' })
    }
    res.sendStatus(200)
  }

  /**
   * GET /api/tandem/active
   * Get current user's active tandem session
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async getActive(req, res) {
    const session = this.tandemManager.getSessionForUser(req.user.id)
    if (!session) {
      return res.json(null)
    }
    res.json(this.tandemManager.sessionToJSON(session))
  }
}

module.exports = new TandemController()
