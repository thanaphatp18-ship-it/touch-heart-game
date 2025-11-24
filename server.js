const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. ผู้เล่นเข้าร่วมห้อง
    socket.on('joinRoom', ({ username, roomCode }) => {
        socket.join(roomCode);

        const cleanName = username.trim();

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                users: [],
                gameState: 'waiting',
                messageBuffer: [], // Buffer เก็บข้อความ โดยใช้ Target ID
                submittedCount: 0
            };
        }

        // ==== Logic สวมรอย (Reconnect) ====
        // ค้นหาคนชื่อซ้ำที่อาจหลุดไป (ใช้ชื่อที่ทำความสะอาดแล้ว)
        const existingUser = rooms[roomCode].users.find(u => u.name === cleanName);

        if (existingUser) {
            // เจอคนชื่อซ้ำ! อัปเดต ID ให้เป็นอันใหม่
            existingUser.id = socket.id;
            console.log(`User rejoined: ${cleanName} (New ID: ${socket.id})`);
        } else {
            // ไม่เจอชื่อซ้ำ สร้างใหม่
            rooms[roomCode].users.push({ id: socket.id, name: cleanName });
        }
        // ====================================

        updateRoomDetails(roomCode);

        // === Logic กู้คืนสถานะ (State Recovery) ===
        if (rooms[roomCode].gameState === 'writing') {
            const user = rooms[roomCode].users.find(u => u.id === socket.id);
            if (user) {
                // ส่งรายชื่อเป้าหมายอีกครั้ง
                const targets = rooms[roomCode].users.filter(u => u.id !== user.id); // กรองด้วย ID เพื่อความแน่นอน
                io.to(user.id).emit('gameStarted', { targets: targets });
                io.to(user.id).emit('updateStatus', `เกมกำลังดำเนินต่อ...`);
            }
        } else if (rooms[roomCode].gameState === 'revealing') {
            io.to(socket.id).emit('allSubmitted');
            // หากต้องการให้เห็นข้อความทันทีเมื่อ Reconnect เข้ามาในหน้า Reveal ให้เรียก distributeMessages(roomCode)
            // แต่เนื่องจากมันถูกเรียกไปแล้วเมื่อจบเกม, การทำซ้ำอาจไม่จำเป็น
        }
    });

    // 2. หัวหน้าห้องกดเริ่มเกม
    socket.on('startGame', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].users.length >= 2) {
            rooms[roomCode].gameState = 'writing';
            rooms[roomCode].messageBuffer = [];
            rooms[roomCode].submittedCount = 0;

            rooms[roomCode].users.forEach(user => {
                // ส่งรายชื่อเป้าหมายให้ทุกคน (กรองตัวเองออกด้วย ID)
                const targets = rooms[roomCode].users.filter(u => u.id !== user.id);
                io.to(user.id).emit('gameStarted', { targets: targets });
            });
        }
    });

    // 3. ผู้เล่นส่งข้อความ
    socket.on('submitMessages', ({ roomCode, messages }) => {
        if (!rooms[roomCode]) return;

        const senderId = socket.id;
        const senderName = rooms[roomCode].users.find(u => u.id === senderId)?.name || 'Unknown';

        messages.forEach(msg => {
            // ค้นหา ID ของเป้าหมายจากชื่อที่ส่งมา
            const targetUser = rooms[roomCode].users.find(u => u.name === msg.targetName);

            if (targetUser) {
                // เก็บข้อความโดยใช้ targetId ใน messageBuffer
                rooms[roomCode].messageBuffer.push({
                    targetId: targetUser.id,
                    senderName: senderName,
                    content: msg.content
                });
            }
        });

        rooms[roomCode].submittedCount++;

        const totalPlayers = rooms[roomCode].users.length;

        io.to(roomCode).emit('updateStatus', `รอเพื่อนๆ ส่งข้อความ (${rooms[roomCode].submittedCount}/${totalPlayers})`);

        if (rooms[roomCode].submittedCount >= totalPlayers) {
            rooms[roomCode].gameState = 'revealing';
            io.to(roomCode).emit('allSubmitted');

            setTimeout(() => {
                distributeMessages(roomCode);
            }, 3500);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected (waiting for reconnect or timeout):', socket.id);
    });

    // 5. Logic การล้างห้องและเล่นใหม่ (Restart)
    socket.on('requestRestart', (roomCode) => {
        if (rooms[roomCode]) {
            console.log(`Room ${roomCode} has been deleted for restart.`);
            io.to(roomCode).emit('roomDeleted');
            delete rooms[roomCode];
        }
    });

    // 6. Logic การอัปเดตห้อง (ใช้สำหรับปุ่ม Refresh)
    socket.on('requestRoomUpdate', (roomCode) => {
        if (rooms[roomCode]) {
            updateRoomDetails(roomCode);
        }
    });

    function distributeMessages(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.users.forEach(user => {
            const userId = user.id;

            // กรองข้อความโดยใช้ targetId (ID ของผู้รับ)
            const myMessages = room.messageBuffer
                .filter(msg => msg.targetId === userId)
                .map(msg => ({
                    content: msg.content
                }));

            io.to(user.id).emit('revealMessages', myMessages);
        });
    }

    // *** ฟังก์ชันสำคัญ: อัปเดตรายชื่อและเปลี่ยน Host อัตโนมัติ ***
    function updateRoomDetails(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // 1. กรองหา Host คนแรกที่ยังเชื่อมต่ออยู่
        const hostUser = room.users.find(u => io.sockets.sockets.has(u.id));

        if (!hostUser) {
            delete rooms[roomCode];
            return;
        }

        const hostId = hostUser.id;

        // 2. กรองผู้ใช้ที่หลุดไป (โดยยึด Host ไว้)
        room.users = room.users.filter(u => io.sockets.sockets.has(u.id) || u.id === hostId);

        if (room.users.length === 0) {
            delete rooms[roomCode];
            return;
        }

        io.to(roomCode).emit('updateRoomData', {
            users: room.users,
            hostId: hostId
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});