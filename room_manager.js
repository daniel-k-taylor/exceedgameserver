import GameRoom from './gameroom.js'

export default class RoomManager {
    constructor() {
        this.rooms = {}
    }

    getRoomInfos() {
        // Return an array of rooms with these fields.
        // {
        //     room_name
        //     room_version
        //     player_count
        //     observer_count
        //     game_started
        //     player_names
        //     player_decks
        // }
        return Object.values(this.rooms).map(room => {
            return {
                room_name: room.name,
                room_version: room.version,
                player_count: room.players.length,
                observer_count: room.get_observer_count(),
                game_started: room.gameStarted,
                player_names: [
                    room.get_player_name(0),
                    room.get_player_name(1)
                ],
                player_decks: [
                    room.get_player_deck(0),
                    room.get_player_deck(1)
                ],
                player_custom_deck_portraits: [
                    room.get_player_custom_deck_portrait(0),
                    room.get_player_custom_deck_portrait(1),
                ],
            }
        })
    }

    findRoom(room_name) {
        return this.rooms[room_name]
    }

    addRoom(
        player_join_version,
        room_name,
        database,
        starting_timer,
        enforce_timer,
        minimum_time_per_choice
    ) {
        this.rooms[room_name] = new GameRoom(player_join_version, room_name, database, starting_timer, enforce_timer, minimum_time_per_choice)
        return this.rooms[room_name]
    }

    leaveRoom(player, disconnect) {
        if (player.room !== null) {
            var room_name = player.room.name
            player.room.player_quit(player, disconnect)
            if (player.room.is_game_over) {
                console.log("Closing room " + room_name)
                this.rooms[room_name].close_room()
                delete this.rooms[room_name]
            }
            player.room = null
        }
    }

    deleteRoom(room_name) {
        if (this.rooms[room_name]) {
            this.rooms[room_name].close_room()
            delete this.rooms[room_name]
        }
    }
}
