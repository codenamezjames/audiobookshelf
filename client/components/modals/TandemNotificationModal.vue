<template>
  <modals-modal v-model="show" name="tandem-notification" :width="400" :height="'unset'">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden pointer-events-none">
        <p class="text-3xl text-white truncate pointer-events-none">Listen Together</p>
      </div>
    </template>

    <div v-if="invite" class="w-full rounded-lg bg-bg box-shadow-md p-6">
      <div class="flex items-center mb-4">
        <span class="material-symbols text-3xl mr-3 text-fg">headphones</span>
        <div>
          <p class="text-lg font-semibold">{{ invite.fromUsername }}</p>
          <p class="text-sm text-gray-400">wants to listen together</p>
        </div>
      </div>

      <div class="bg-primary/30 rounded-md p-3 mb-6">
        <p class="text-sm text-gray-300">Book:</p>
        <p class="text-base font-medium">{{ invite.displayTitle }}</p>
      </div>

      <div class="flex space-x-3">
        <ui-btn class="flex-1" color="bg-success" @click="accept">Accept</ui-btn>
        <ui-btn class="flex-1" color="bg-error" @click="decline">Decline</ui-btn>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(val) {
        this.$emit('input', val)
      }
    },
    invite() {
      return this.$store.state.tandemInvite
    }
  },
  watch: {
    invite(val) {
      if (val) {
        this.show = true
      }
    }
  },
  methods: {
    accept() {
      if (!this.invite) return
      const socket = this.$root.socket
      if (socket) {
        socket.emit('tandem_invite_response', {
          inviteId: this.invite.inviteId,
          accepted: true
        })
      }

      // Set up tandem session state
      this.$store.commit('setTandemSession', {
        id: this.invite.sessionId,
        libraryItemId: this.invite.libraryItemId,
        episodeId: this.invite.episodeId,
        displayTitle: this.invite.displayTitle,
        members: []
      })
      this.$store.commit('setTandemInvite', null)

      // Start playback of the invited book at the synced position
      this.$eventBus.$emit('play-item', {
        libraryItemId: this.invite.libraryItemId,
        episodeId: this.invite.episodeId || null,
        startTime: this.invite.position || 0
      })

      // Start tandem sync after a short delay to let the player load
      setTimeout(() => {
        this.$eventBus.$emit('tandem-start')
      }, 500)
      this.show = false
    },
    decline() {
      if (!this.invite) return
      const socket = this.$root.socket
      if (socket) {
        socket.emit('tandem_invite_response', {
          inviteId: this.invite.inviteId,
          accepted: false
        })
      }
      this.$store.commit('setTandemInvite', null)
      this.show = false
    }
  }
}
</script>
