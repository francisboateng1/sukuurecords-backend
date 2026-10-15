const db = require('../db');

module.exports = async (req, res, next) => {



    console.log(
    'SUBSCRIPTION CHECK:',
    req.method,
    req.originalUrl,
    'school_id:',
    req.user?.school_id
);



    try {
        // User must already be authenticated
        if (!req.user || !req.user.school_id) {
            return res.status(401).json({
                message: 'Authentication required.'
            });
        }

        const schoolId = req.user.school_id;

        const [schools] = await db.query(
            `
            SELECT 
                id,
                sub_status,
                created_at,
                subscription_end_date
            FROM schools
            WHERE id = ?
            LIMIT 1
            `,
            [schoolId]
        );

        if (schools.length === 0) {
            return res.status(403).json({
                message: 'School account not found.'
            });
        }

        const school = schools[0];

        const now = new Date();

        // =====================================================
        // ACTIVE SUBSCRIPTION
        // =====================================================
        if (
            school.sub_status === 'active' &&
            school.subscription_end_date
        ) {
            const subscriptionEnd = new Date(
                school.subscription_end_date
            );

            if (subscriptionEnd > now) {
                return next();
            }

            // Subscription has expired
            return res.status(402).json({
                message: 'Your subscription has expired. Please renew to continue.',
                code: 'SUBSCRIPTION_REQUIRED',
                status: 'expired'
            });
        }

        // =====================================================
        // TRIAL PERIOD
        // =====================================================
        if (school.sub_status === 'trial' && school.created_at) {
            const trialStart = new Date(school.created_at);

            // 14-day trial
            const trialEnd = new Date(trialStart);
            trialEnd.setDate(trialEnd.getDate() + 14);

            if (trialEnd > now) {
                return next();
            }

            // Trial has expired
            return res.status(402).json({
                message: 'Your free trial has expired. Please subscribe to continue.',
                code: 'SUBSCRIPTION_REQUIRED',
                status: 'expired'
            });
        }

        // =====================================================
        // ANY OTHER STATUS
        // =====================================================
        return res.status(402).json({
            message: 'An active subscription is required to use the system.',
            code: 'SUBSCRIPTION_REQUIRED',
            status: 'expired'
        });

    } catch (error) {
        console.error('Subscription middleware error:', error);

        return res.status(500).json({
            message: 'Unable to verify subscription status.'
        });
    }
};