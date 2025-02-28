class Player {
    constructor(ws, id, name) {
      this.ws = ws
      this.id = id
      this.name = name
      this.timeout = null
      this.deck_id = ""
      this.room = null
      this.version = "?"
      this.playing_AI = false
    }

    set_name(version, name) {
      this.version = version
      this.name = name
      const message = {
          type: 'name_update',
          name: this.name,
      }
      this.ws.send(JSON.stringify(message))
    }

    set_playing_AI(playing) {
      this.playing_AI = playing
    }

    set_deck_id(deck_id) {
      this.deck_id = deck_id
    }

    set_room(room) {
      this.room = room
    }
  }

  export default Player
