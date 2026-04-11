// server.js
require('dotenv/config');
const http   = require('http');
const app    = require('./app');
const { initSocket } = require('./config/socket');

const PORT   = process.env.PORT || 4000;
const server = http.createServer(app);

// ✅ Socket.IO debe recibir el httpServer, NO el app de express
initSocket(server);

server.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;