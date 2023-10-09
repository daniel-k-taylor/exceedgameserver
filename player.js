class Player {
    constructor(ws, id, name) {
      this.ws = ws
      this.id = id
      this.name = name
      this.deck_id = ""
    }

    set_name(name) {
      this.name = name
    }

    set_deck_id(deck_id) {
      this.deck_id = deck_id
    }
  }

  export default Player
