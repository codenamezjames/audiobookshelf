<template>
  <modals-modal v-model="show" name="tandem-invite" :width="400" :height="'unset'">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden pointer-events-none">
        <p class="text-3xl text-white truncate pointer-events-none">Listen Together</p>
      </div>
    </template>

    <div class="w-full rounded-lg bg-bg box-shadow-md overflow-y-auto overflow-x-hidden" style="max-height: 80vh">
      <div v-if="loading" class="flex items-center justify-center py-8">
        <ui-loading-indicator />
      </div>
      <div v-else-if="!users.length" class="px-6 py-8 text-center">
        <p class="text-gray-400">No other users online</p>
      </div>
      <div v-else class="w-full">
        <p class="px-6 pt-4 pb-2 text-sm text-gray-400">Select a user to invite:</p>
        <template v-for="user in users">
          <div :key="user.id" class="flex items-center px-6 py-3 cursor-pointer hover:bg-primary/25" @click="inviteUser(user)">
            <span class="material-symbols text-xl mr-3">person</span>
            <div>
              <p class="text-base">{{ user.username }}</p>
              <p v-if="user.session" class="text-xs text-gray-400">Listening to: {{ user.session.displayTitle }}</p>
            </div>
          </div>
        </template>
      </div>

      <div v-if="isTandemActive" class="w-full px-6 py-4 border-t border-white/10">
        <p class="text-sm text-gray-400 mb-2">Active session with:</p>
        <div v-for="member in tandemMembers" :key="member.userId" class="flex items-center py-1">
          <span class="material-symbols text-sm mr-2 text-green-400">circle</span>
          <p class="text-sm">{{ member.username }}</p>
        </div>
        <ui-btn class="w-full mt-3" color="bg-error" @click="leaveSession">Leave Session</ui-btn>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean
  },
  data() {
    return {
      loading: false,
      users: []
    }
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
    isTandemActive() {
      return this.$store.getters.getIsTandemActive
    },
    tandemMembers() {
      return this.$store.state.tandemSession?.members || []
    },
    currentUserId() {
      return this.$store.state.user.user?.id
    }
  },
  watch: {
    show(val) {
      if (val) {
        this.fetchUsers()
      }
    }
  },
  methods: {
    async fetchUsers() {
      this.loading = true
      try {
        const users = await this.$axios.$get('/api/tandem/users')
        this.users = users || []
      } catch (err) {
        console.error('Failed to fetch online users', err)
        this.users = []
      }
      this.loading = false
    },
    async inviteUser(user) {
      try {
        const libraryItem = this.$store.state.streamLibraryItem
        const episodeId = this.$store.state.streamEpisodeId
        if (!libraryItem) return

        const payload = {
          toUserId: user.id,
          libraryItemId: libraryItem.id,
          episodeId: episodeId || null,
          displayTitle: libraryItem.media?.metadata?.title || 'Unknown',
          currentPosition: this.$eventBus.playerHandler?.getCurrentTime() || 0,
          playbackSpeed: this.$store.getters['user/getUserSetting']('playbackRate') || 1
        }

        const result = await this.$axios.$post('/api/tandem/invite', payload)
        if (result?.session) {
          this.$store.commit('setTandemSession', result.session)
          // Start tandem sync in player
          this.$eventBus.$emit('tandem-start')
          this.$toast.success(`Invite sent to ${user.username}`)
        }
      } catch (err) {
        console.error('Failed to send tandem invite', err)
        this.$toast.error('Failed to send invite')
      }
    },
    async leaveSession() {
      try {
        await this.$axios.$post(`/api/tandem/${this.$store.state.tandemSession?.id}/leave`)
      } catch (err) {
        console.error('Failed to leave tandem session', err)
      }
      this.$store.commit('setTandemSession', null)
      this.$eventBus.$emit('tandem-stop')
      this.show = false
    }
  }
}
</script>
