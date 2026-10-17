module.exports = (req, res, next) => {
    // The authentication middleware must run first.
    if (!req.user) {
        return res.status(401).json({
            message: 'Authentication required.'
        });
    }

    // Only administrators may access protected admin endpoints.
    if (req.user.role !== 'admin') {
        return res.status(403).json({
            message: 'Administrator access required.'
        });
    }

    // Continue to the requested route.
    next();
};
