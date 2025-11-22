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

    socket.on('joinRoom', ({ username, roomCode }) => {
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                users: [],
                gameState: 'waiting',
                messageBuffer: [],
                submittedCount: 0
            };
        }

        // เช็คก่อนว่าชื่อซ้ำในห้องไหม ถ้าซ้ำให้เติมเลขต่อท้าย (เช่น ตูนโวย (2))
        let finalName = username;
        let count = 2;
        while (rooms[roomCode].users.some(u => u.name === finalName)) {
            finalName = `${username} (${count})`;
            count++;
        }

        rooms[roomCode].users.push({ id: socket.id, name: finalName });
        updateRoomDetails(roomCode);
    });

    socket.on('startGame', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].users.length >= 2) {
            rooms[roomCode].gameState = 'writing';
            rooms[roomCode].users.forEach(user => {
                const targets = rooms[roomCode].users.filter(u => u.id !== user.id);
                io.to(user.id).emit('gameStarted', { targets: targets });
            });
        }
    });

    socket.on('submitMessages', ({ roomCode, messages }) => {
        if (!rooms[roomCode]) return;
        rooms[roomCode].messageBuffer.push(...messages);
        rooms[roomCode].submittedCount++;
        const totalPlayers = rooms[roomCode].users.length;

        io.to(roomCode).emit('updateStatus', `รอเพื่อนๆ ส่งข้อความ (${rooms[roomCode].submittedCount}/${totalPlayers})`);

        if (rooms[roomCode].submittedCount === totalPlayers) {
            rooms[roomCode].gameState = 'revealing';
            io.to(roomCode).emit('allSubmitted');
            setTimeout(() => {
                distributeMessages(roomCode);
            }, 3500);
        }
    });

    // ==== ส่วนที่เพิ่มมาใหม่: จัดการเมื่อคนหลุด/รีเฟรช ====
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        // วนหาว่า User ที่หลุด อยู่ห้องไหน
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const index = room.users.findIndex(u => u.id === socket.id);

            if (index !== -1) {
                // ลบ User ออกจาก array
                room.users.splice(index, 1);

                // ถ้าห้องว่างเปล่า ให้ลบห้องทิ้ง
                if (room.users.length === 0) {
                    delete rooms[roomCode];
                } else {
                    // ถ้ายังมีคนอยู่ ให้ update ข้อมูลใหม่ให้คนที่เหลือ
                    // (ถ้า Host หลุด คนที่ 2 จะกลายเป็น users[0] อัตโนมัติ)
                    updateRoomDetails(roomCode);
                }
                break;
            }
        }
    });

    function distributeMessages(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.users.forEach(user => {
            // แก้ตรงนี้: เช็คจากชื่อ (targetName === user.name) แทน ID
            const myMessages = room.messageBuffer
                .filter(msg => msg.targetName === user.name)
                .map(msg => ({ content: msg.content }));

            io.to(user.id).emit('revealMessages', myMessages);
        });

        // (Optional) ล้างข้อมูลห้องหลังเล่นจบ เพื่อประหยัด Ram
        // delete rooms[roomCode];
    }

    // ฟังก์ชันช่วยส่งข้อมูลห้อง (แก้ Logic การหา Host)
    function updateRoomDetails(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // ส่งข้อมูลให้ทุกคน โดยบอกด้วยว่า "ใครคือ Host ID ปัจจุบัน"
        const hostId = room.users[0].id;

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