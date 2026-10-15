const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    // 1. Get the token from the request header (Authorization: Bearer <token>)
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; 

    // 2. If no token, reject the request
    if (!token) {
        return res.status(401).json({ message: "Access denied. No token provided." });
    }

    try {
        // 3. Verify the token using your secret key
        const secret = process.env.JWT_SECRET || 'your_secret_key';
        const decoded = jwt.verify(token, secret);
        
        // 4. Attach the decoded user data (including school_id!) to the request
        req.user = decoded; 
        
        // 5. Move to the next function (the actual route handler)
        next();
    } catch (err) {
        res.status(403).json({ message: "Invalid or expired token." });
    }
};