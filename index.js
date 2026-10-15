const express = require('express');
const cors = require('cors');
require('dotenv').config();

// 1. Initialize Express
const app = express();
const verifyToken = require('./middleware/authMiddleware'); // Import the new file
const subscriptionMiddleware = require('./middleware/subscriptionMiddleware');


// 2. Import All Routes
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/students');
const assessmentRoutes = require('./routes/assessments');
const attendanceRoutes = require('./routes/attendance'); // MOVED UP
const settingsRoutes = require('./routes/settings'); // 1. ADD THIS LINE
const paymentRoutes = require('./routes/payments');
const promotionRoutes = require('./routes/promotion');


// 3. Global Middleware
// Allowed frontend origins
const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(process.env.FRONTEND_URLS || '')
        .split(',')
        .map(url => url.trim())
        .filter(Boolean)
]);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests without an Origin header, such as server-side
        // requests and some development tools.
        if (!origin || allowedOrigins.has(origin)) {
            return callback(null, true);
        }

        // Do not grant cross-origin access to unapproved websites.
        return callback(null, false);
    },
    credentials: true
}));

// --- ADD THESE TWO LINES HERE ---
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
})); // This allows the server to read JSON data
app.use(express.urlencoded({ extended: true })); 
// ----------




// 4. Use Routes
app.use('/api/auth', authRoutes);
app.use('/api/students', verifyToken, subscriptionMiddleware, studentRoutes);
app.use('/api/assessments', verifyToken, subscriptionMiddleware, assessmentRoutes); // Added verifyToken and subscriptionMiddleware
app.use('/api/attendance', verifyToken, subscriptionMiddleware, attendanceRoutes); // Added verifyToken and subscriptionMiddleware
app.use('/api/settings', verifyToken, subscriptionMiddleware, settingsRoutes);

// Payment routes handle their own authentication
// because Paystack webhook must remain public.
app.use('/api/payments', paymentRoutes);



app.get('/api/settings/test', (req, res) => {
    console.log('SETTINGS TEST ROUTE HIT');
    res.json({
        message: 'Settings route is reachable'
    });
});
// Add this near your other app.use() lines
app.use('/uploads', express.static('uploads'));

// 5. Test Route
app.get('/', (req, res) => {
    res.send('SMS API is running smoothly.');
});

//promotion routes for student promotion
app.use(
    '/api',
    promotionRoutes
);



// 6. Start Server
const PORT = process.env.PORT || 10000; // Render uses 10000 or a dynamic port
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

