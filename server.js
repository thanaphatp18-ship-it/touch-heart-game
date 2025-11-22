// --- server.js ---
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// ให้บริการไฟล์ static (html, css)
app.use(express.static(__dirname));

// เก็บข้อมูลสถานะของห้องต่างๆ
// โครงสร้าง: { roomCode: { users: [], gameState: 'waiting', messageBuffer: [] } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // 1. ผู้เล่นเข้าร่วมห้อง (สร้างห้องใหม่ถ้ายังไม่มี)
    socket.on('joinRoom', ({ username, roomCode }) => {
        socket.join(roomCode);

        // ถ้าไม่มีห้องนี้ให้สร้างใหม่
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                users: [],
                gameState: 'waiting',
                messageBuffer: [], // ที่พักข้อความ
                submittedCount: 0 // นับคนส่งแล้ว
            };
        }

        // เพิ่ม user เข้าห้อง
        rooms[roomCode].users.push({ id: socket.id, name: username });

        // แจ้งทุกคนในห้องให้ update รายชื่อ
        io.to(roomCode).emit('updateRoomData', {
            roomCode: roomCode,
            users: rooms[roomCode].users,
            isHost: rooms[roomCode].users[0].id === socket.id // คนแรกคือหัวหน้าห้อง
        });
    });

    // 2. หัวหน้าห้องกดเริ่มเกม
    socket.on('startGame', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].users.length >= 2) { // ต้องมีอย่างน้อย 2 คน
            rooms[roomCode].gameState = 'writing';
            // ส่งสัญญาณเริ่มเกม พร้อมรายชื่อคนอื่นๆ ที่ไม่ใช่ตัวเองไปให้แต่ละ client
            rooms[roomCode].users.forEach(user => {
                const targets = rooms[roomCode].users.filter(u => u.id !== user.id);
                io.to(user.id).emit('gameStarted', { targets: targets });
            });
        }
    });

    // 3. ผู้เล่นส่งข้อความ (Submit)
    socket.on('submitMessages', ({ roomCode, messages }) => {
        if (!rooms[roomCode]) return;

        // เก็บข้อความลง Buffer รวม
        rooms[roomCode].messageBuffer.push(...messages);
        rooms[roomCode].submittedCount++;

        const totalPlayers = rooms[roomCode].users.length;

        // แจ้งความคืบหน้า (เช่น รออีก 2 คน)
        io.to(roomCode).emit('updateStatus', `รอเพื่อนๆ ส่งข้อความ (${rooms[roomCode].submittedCount}/${totalPlayers})`);

        // เช็คว่าส่งครบทุกคนหรือยัง
        if (rooms[roomCode].submittedCount === totalPlayers) {
            rooms[roomCode].gameState = 'revealing';
            io.to(roomCode).emit('allSubmitted'); // เริ่มนับถอยหลังที่หน้าบ้าน

            // รอ 3 วินาที (ตามเวลานับถอยหลัง) แล้วค่อยเฉลย
            setTimeout(() => {
                distributeMessages(roomCode);
            }, 3500);
        }
    });

    // ฟังก์ชันกระจายข้อความ (ส่วนสำคัญคือการไม่ระบุชื่อ)
    function distributeMessages(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.users.forEach(user => {
            // หาข้อความที่เป็นของ user คนนี้
            const myMessages = room.messageBuffer
                .filter(msg => msg.targetId === user.id)
                .map(msg => ({ content: msg.content })); // ***สำคัญ: เลือกส่งกลับไปแค่เนื้อหา ไม่ส่งชื่อคนส่ง***

            io.to(user.id).emit('revealMessages', myMessages);
        });

        // Reset ห้องหลังจบเกม (เผื่อเล่นต่อ - optional)
        // delete rooms[roomCode]; 
    }

    // Handle คนหลุดออกจากห้อง (Basic)
    socket.on('disconnect', () => {
        // ในระบบจริงต้องไล่ลบ user ออกจาก rooms และแจ้งคนอื่น
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});