import Player from './player.js'

class GameRoom {
  constructor(version, room_name) {
    this.name = room_name
    this.players = []
    this.gameStarted = false
    this.version = version
    this.observers = []
    this.message_log = []
    this.is_game_over = false
  }

  get_observer_count() {
    return this.observers.length
  }

  get_player_name(index) {
    if (index < this.players.length) {
      return this.players[index].name
    }
    return ""
  }

  get_player_deck(index) {
    if (index < this.players.length) {
      return this.players[index].deck_id
    }
    return ""
  }

  join(player) {
    if (this.players.length < 2 && !this.gameStarted) {
      this.players.push(player)
      player.set_room(this)
      console.log(`Player joined. Total players: ${this.players.length}`)
      if (this.players.length === 2) {
        this.startGame()
      } else {
        const message = {
          type: 'room_waiting_for_opponent',
        }
        player.ws.send(JSON.stringify(message))
      }
      return true
    }
    return false
  }

  observe(player) {
    player.set_room(this)
    this.observers.push(player)

    const message = {
      type: 'observe_start',
      messages: this.message_log
    }
    player.ws.send(JSON.stringify(message))
    return true
  }

  is_observer(player) {
    return this.observers.includes(player)
  }

  is_player(player) {
    return this.players.includes(player)
  }

  game_over() {
    this.is_game_over = true
    for (const player of this.players) {
      player.set_room(null)
    }
    for (const player of this.observers) {
      player.set_room(null)
    }
  }

  startGame() {
    if (this.players.length === 2 && !this.gameStarted) {
      this.gameStarted = true
      console.log('Game started!')
      const starting_player = Math.random() < 0.5 ? 0 : 1
      const seed = Math.floor(Math.random() * 9223372036854775807)
      const message = {
        type: 'game_start',
        seed_value: seed,
        starting_player_id: this.players[starting_player].id,
        player1_name: this.players[0].name,
        player1_id: this.players[0].id,
        player1_deck_id: this.players[0].deck_id,
        player2_name: this.players[1].name,
        player2_id: this.players[1].id,
        player2_deck_id: this.players[1].deck_id,
      }
      this.broadcast(message)
    }
  }

  handle_game_message(player, message) {
    // Broadcast this message to both players.
    this.broadcast(message)
  }

  broadcast(message) {
    console.log("Broadcast message type: " + message.type)
    this.message_log.push(message)
    for (const player of this.players) {
      message['your_player_id'] = player.id
      player.ws.send(JSON.stringify(message))
    }
    for (const player of this.observers) {
      player.ws.send(JSON.stringify(message))
    }
  }

  player_quit(player, disconnect) {
    if (this.is_observer(player)) {
      this.observers = this.observers.filter(p => p !== player)
    } else if (this.is_player(player)) {
      this.players = this.players.filter(p => p !== player)
      const message = {
        type: disconnect ? 'player_disconnect' : 'player_quit',
        id: player.id,
        name: player.name
      }
      this.broadcast(message)
      this.game_over()
    }
  }
}

export default GameRoom
