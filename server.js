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

        // ==== Logic สวมรอย (Reconnect) ====
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
                const targets = rooms[roomCode].users.filter(u => u.name !== user.name);
                io.to(user.id).emit('gameStarted', { targets: targets });
                io.to(user.id).emit('updateStatus', `เกมกำลังดำเนินต่อ...`);
            }
        } else if (rooms[roomCode].gameState === 'revealing') {
            // ส่ง event allSubmitted เพื่อเริ่มนับถอยหลังทันที
            io.to(socket.id).emit('allSubmitted');
        }
    });

    // 2. หัวหน้าห้องกดเริ่มเกม
    socket.on('startGame', (roomCode) => {
        if (rooms[roomCode] && rooms[roomCode].users.length >= 2) {
            rooms[roomCode].gameState = 'writing';
            // รีเซ็ต Buffer และ Counter สำหรับรอบใหม่ (กรณีมี State ค้าง)
            rooms[roomCode].messageBuffer = [];
            rooms[roomCode].submittedCount = 0;

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

    // 4. จัดการเมื่อคนหลุด (ปล่อยให้ Reconnect Logic จัดการ)
    socket.on('disconnect', () => {
        console.log('User disconnected (waiting for reconnect or timeout):', socket.id);

        // *หมายเหตุ: หากต้องการล้างผู้เล่นออกจากรายชื่อที่หลุดไปจริงๆ ให้เรียก updateRoomDetails ใน setTimeout
        // แต่ในโค้ดนี้ เราจะให้ปุ่ม Refresh/Logic Reconnect จัดการแทน
    });

    // 5. Logic การล้างห้องและเล่นใหม่ (Restart)
    socket.on('requestRestart', (roomCode) => {
        if (rooms[roomCode]) {
            console.log(`Room ${roomCode} has been deleted for restart.`);
            // แจ้งทุกคนในห้องว่าห้องถูกลบแล้ว
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
            const userCleanName = user.name.trim().toLowerCase();

            // กรองข้อความด้วยชื่อ (Case-insensitive)
            const myMessages = room.messageBuffer
                .filter(msg => {
                    const targetCleanName = msg.targetName ? msg.targetName.trim().toLowerCase() : '';
                    return targetCleanName === userCleanName;
                })
                .map(msg => ({ content: msg.content }));

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
            // ถ้าไม่มีใครเชื่อมต่ออยู่เลย
            delete rooms[roomCode];
            return;
        }

        const hostId = hostUser.id;

        // 2. กรองผู้ใช้ที่หลุดไป (เพื่อความสะอาดของรายชื่อ)
        room.users = room.users.filter(u => io.sockets.sockets.has(u.id) || u.id === hostId);

        // 3. ป้องกัน error กรณีไม่มี user เหลือหลังกรอง
        if (room.users.length === 0) {
            delete rooms[roomCode];
            return;
        }

        io.to(roomCode).emit('updateRoomData', {
            users: room.users,
            hostId: hostId // ID ของ Host ที่ใช้งานอยู่
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});