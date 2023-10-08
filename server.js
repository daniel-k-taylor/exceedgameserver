import { WebSocketServer } from 'ws';

const port = process.env.PORT || 8080
const wss = new WebSocketServer({ port: port });

wss.on('connection', function connection(ws) {
  ws.on('message', function message(data) {
    console.log('received: %s', data);
	ws.send('I got your: ' + data)
  });

  ws.send('something');
});