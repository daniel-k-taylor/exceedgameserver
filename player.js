class Player {
    constructor(ws, id, name, session_id, session_token) {
      this.ws = ws
      this.id = id
      this.name = name
      // session_id is a public handle safe to log/broadcast.
      // session_token is the secret credential the client presents to restore this session.
      this.session_id = session_id
      this.session_token = session_token
      this.timeout = null
      this.deck_id = ""
      this.custom_deck_definition = null
      this.room = null
      this.queue_id = null
      this.version = "?"
      this.playing_AI = false
      this.lobby_state = "Lobby"
      this.connected = true
      this.last_disconnect_at = null
      this.awaiting_pong = false
    }

    get_identity() {
      return {
        player_id: this.id,
        session_id: this.session_id,
        session_token: this.session_token,
      }
    }

    set_name(version, name) {
      this.version = version
      this.name = name
      const message = {
          type: 'name_update',
          name: this.name,
          ...this.get_identity(),
      }
      this.send(message)
    }

    set_playing_AI(playing) {
      this.playing_AI = playing
    }

    set_deck_id(deck_id, custom_deck_definition) {
      this.deck_id = deck_id
      this.custom_deck_definition = custom_deck_definition
    }

    set_room(room) {
      this.room = room
    }

    attach_connection(ws) {
      this.ws = ws
      this.connected = true
      this.last_disconnect_at = null
      this.awaiting_pong = false
    }

    detach_connection() {
      this.ws = null
      this.connected = false
      this.last_disconnect_at = new Date()
      this.awaiting_pong = false
    }

    mark_pong() {
      this.awaiting_pong = false
    }

    // Sending is a no-op while the player is disconnected but still holding a
    // seat, so callers never have to null check the websocket.
    send(message) {
      if (!this.ws || !this.connected) {
        return false
      }
      try {
        this.ws.send(JSON.stringify(message))
        return true
      } catch (error) {
        console.log(`Failed to send message to player ${this.id}:`, error)
        return false
      }
    }
  }

  export default Player
