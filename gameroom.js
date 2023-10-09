import Player from './player.js'

class GameRoom {
  constructor(room_name) {
    this.name = room_name
    this.players = []
    this.gameStarted = false
  }

  join(player) {
    if (this.players.length < 2 && !this.gameStarted) {
      this.players.push(player)
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

  startGame() {
    if (this.players.length === 2 && !this.gameStarted) {
      this.gameStarted = true
      console.log('Game started!')
      const message = {
        type: 'game_start',
        player1_name: this.players[0].name,
        player1_id: this.players[0].id,
        player2_name: this.players[1].name,
        player2_id: this.players[1].id
      }
      this.broadcast(message)
    }
  }

  broadcast(message) {
    console.log("Broadcast message type: " + message.type)
    for (const player of this.players) {
      player.ws.send(JSON.stringify(message))
    }
  }

  player_disconnect(player) {
    this.players = this.players.filter(p => p !== player)
    const message = {
      type: 'player_disconnect',
      id: player.id,
      name: player.name
    }
    this.broadcast(message)
  }
}

export default GameRoom
