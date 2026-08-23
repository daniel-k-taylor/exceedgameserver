import GameRoom from './gameroom.js'

export default class RoomManager {
    constructor(reconnect_grace_ms = 0) {
        this.rooms = {}
        this.reconnect_grace_ms = reconnect_grace_ms
    }

    getRoomInfos() {
        // Return an array of rooms with these fields.
        // {
        //     room_name
        //     room_version
        //     player_count
        //     connected_player_count
        //     observer_count
        //     game_started
        //     game_over
        //     player_names
        //     player_decks
        //     player_connected
        // }
        return Object.values(this.rooms).filter(room => !room.is_empty()).map(room => {
            return {
                room_name: room.name,
                room_version: room.version,
                player_count: room.players.length,
                connected_player_count: room.get_connected_player_count(),
                observer_count: room.get_observer_count(),
                game_started: room.gameStarted,
                game_over: room.is_game_over,
                player_names: [
                    room.get_player_name(0),
                    room.get_player_name(1)
                ],
                player_decks: [
                    room.get_player_deck(0),
                    room.get_player_deck(1)
                ],
                player_connected: [
                    room.players.length > 0 ? room.players[0].connected : false,
                    room.players.length > 1 ? room.players[1].connected : false,
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

    // Accepts either the internal room name or the name a client would send,
    // which omits the "custom_" prefix added by the custom room flow.
    findRoomByJoinId(room_name) {
        if (this.rooms[room_name]) {
            return this.rooms[room_name]
        }
        return this.rooms[`custom_${room_name}`]
    }

    addRoom(
        player_join_version,
        room_name,
        database,
        starting_timer,
        enforce_timer,
        minimum_time_per_choice
    ) {
        this.rooms[room_name] = new GameRoom(
            player_join_version,
            room_name,
            database,
            starting_timer,
            enforce_timer,
            minimum_time_per_choice,
            this.reconnect_grace_ms
        )
        return this.rooms[room_name]
    }

    leaveRoom(player, disconnect) {
        if (player.room !== null) {
            const room = player.room
            const should_leave_room = room.player_quit(player, disconnect)
            if (should_leave_room) {
                player.room = null
            }
            if (room.is_empty()) {
                console.log("Closing room " + room.name)
                this.deleteRoom(room.name)
            }
        }
    }

    deleteRoom(room_name) {
        if (this.rooms[room_name]) {
            this.rooms[room_name].close_room()
            delete this.rooms[room_name]
        }
    }

    // Removes players whose connection died without a clean close, expires seats
    // held past the reconnect grace period, and deletes rooms nobody is left in.
    // Callers are expected to have already detached dead connections so that
    // player.connected and player.last_disconnect_at are accurate.
    // Returns true when anything visible to the lobby changed.
    sweep(is_player_alive, now = Date.now()) {
        var changed = false
        for (const room of Object.values(this.rooms)) {
            for (const observer of [...room.observers]) {
                if (!is_player_alive(observer)) {
                    room.player_quit(observer, true)
                    observer.room = null
                    changed = true
                }
            }

            for (const player of [...room.players]) {
                if (is_player_alive(player)) {
                    continue
                }
                if (!room.gameStarted || room.is_game_over) {
                    // No live game to come back to, so treat it as a plain quit.
                    room.player_quit(player, true)
                    player.room = null
                    changed = true
                    continue
                }
                const deadline = room.get_reconnect_deadline(player, this.reconnect_grace_ms)
                if (deadline === null || now >= deadline) {
                    room.expire_held_seat(player)
                    player.room = null
                    changed = true
                }
            }
        }

        for (const room_name of Object.keys(this.rooms)) {
            if (this.rooms[room_name].is_empty()) {
                this.deleteRoom(room_name)
                changed = true
            }
        }

        return changed
    }
}
