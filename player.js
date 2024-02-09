class Player {
    constructor(ws, id, name) {
      this.ws = ws
      this.id = id
      this.name = name
      this.timeout = null
      this.deck_id = ""
      this.room = null
      this.version = "?"
    }

    set_name(version, name) {
      this.version = version
      this.name = name
    }

    set_deck_id(deck_id) {
      this.deck_id = deck_id
    }

    set_room(room) {
      this.room = room
    }
  }

  export default Player
