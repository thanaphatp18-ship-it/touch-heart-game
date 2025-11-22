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

        // ตัดช่องว่างหน้าหลังออกกันพลาด
        const cleanName = username.trim();

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                users: [],
                gameState: 'waiting',
                messageBuffer: [],
                submittedCount: 0
            };
        }

        // ==== จุดที่แก้ใหม่ (Logic สวมรอย) ====
        // เช็คว่ามีชื่อนี้ในห้องแล้วหรือยัง?
        const existingUser = rooms[roomCode].users.find(u => u.name === cleanName);

        if (existingUser) {
            // เจอคนชื่อซ้ำ! สันนิษฐานว่าเป็นคนเดิมที่กด Refresh
            // อัปเดต ID ให้เป็นอันใหม่ปัจจุบัน
            existingUser.id = socket.id;
            console.log(`User rejoined: ${cleanName} (New ID: ${socket.id})`);
        } else {
            // ไม่เจอชื่อซ้ำ สร้างใหม่ตามปกติ
            rooms[roomCode].users.push({ id: socket.id, name: cleanName });
        }
        // ====================================

        updateRoomDetails(roomCode);
        // === ส่วนที่เพิ่ม: การกู้คืนสถานะ ===
        if (rooms[roomCode].gameState === 'writing') {
            // ถ้าเกมกำลังเขียน ให้ส่ง event gameStarted ไปอีกรอบ
            const user = rooms[roomCode].users.find(u => u.id === socket.id);
            if (user) {
                const targets = rooms[roomCode].users.filter(u => u.name !== user.name);
                io.to(user.id).emit('gameStarted', { targets: targets });
                io.to(user.id).emit('updateStatus', `เกมกำลังดำเนินต่อ...`);
            }
        } else if (rooms[roomCode].gameState === 'revealing') {
            // ถ้าเกมจบแล้ว ให้ส่ง event allSubmitted เพื่อเริ่มนับถอยหลังทันที
            io.to(socket.id).emit('allSubmitted');
            // Server จะ distributeMessages เองในไม่ช้า
        }
    });

    // 2. หัวหน้าห้องกดเริ่มเกม
    socket.on('startGame', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].users.length >= 2) {
            rooms[roomCode].gameState = 'writing';
            rooms[roomCode].users.forEach(user => {
                // ส่งรายชื่อเป้าหมายให้ทุกคน (กรองตัวเองออก)
                const targets = rooms[roomCode].users.filter(u => u.name !== user.name);
                io.to(user.id).emit('gameStarted', { targets: targets });
            });
        }
    });

    // 3. ผู้เล่นส่งข้อความ
    socket.on('submitMessages', ({ roomCode, messages }) => {
        if (!rooms[roomCode]) return;

        rooms[roomCode].messageBuffer.push(...messages);
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

    // 4. จัดการเมื่อคนหลุด
    socket.on('disconnect', () => {
        // เราจะไม่รีบลบ user ทันที เพื่อรองรับกรณี refresh แล้วกลับมา
        // แต่ถ้าอยากลบจริงๆ อาจต้องใช้วิธีอื่น หรือปล่อยไว้แบบนี้เพื่อให้ Reconnect ได้
        console.log('User disconnected (waiting for reconnect or timeout):', socket.id);

        // *หมายเหตุ: ใน Logic แบบสวมรอย เราจะไม่ลบ User ออกจาก array ทันทีที่ disconnect
        // เพราะถ้าลบไป เดี๋ยวตอน connect เข้ามาใหม่ มันจะหาชื่อเก่าไม่เจอ
        // เราจะปล่อยให้ชื่อค้างไว้ ถ้าเขาไม่กลับมาจริงๆ ค่อยให้คนในห้องสร้างห้องใหม่เล่นกัน
    });

    function distributeMessages(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        room.users.forEach(user => {
            // คัดแยกจดหมายด้วย "ชื่อ" (Name)
            const myMessages = room.messageBuffer
                .filter(msg => msg.targetName === user.name)
                .map(msg => ({ content: msg.content }));

            io.to(user.id).emit('revealMessages', myMessages);
        });

        // เคลียร์ห้องหลังจบเกม (ถ้าต้องการ)
        // delete rooms[roomCode];
    }

    function updateRoomDetails(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;

        // ป้องกัน error กรณีไม่มี user เหลือ
        if (room.users.length === 0) return;

        const hostId = room.users[0].id;

        io.to(roomCode).emit('updateRoomData', {
            users: room.users,
            hostId: hostId
        });
    }

    // ในไฟล์ server.js หา socket.on('requestRestart', (roomCode) => { ... });

    socket.on('requestRestart', (roomCode) => {
        // ลบห้องทิ้ง เพื่อเคลียร์ข้อมูลทั้งหมด
        if (rooms[roomCode]) {
            console.log(`Room ${roomCode} has been deleted for restart.`);

            // *** ต้องเพิ่มบรรทัดนี้ เพื่อแจ้งเตือนผู้เล่นที่เหลือในห้อง ***
            io.to(roomCode).emit('roomDeleted');
            // *********************************************************

            delete rooms[roomCode];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});