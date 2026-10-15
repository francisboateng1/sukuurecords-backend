const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');
const verifyToken = require('../middleware/authMiddleware');

const router = express.Router();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const MONTHLY_AMOUNT = 10000; // GH₵100 in pesewas
const CURRENCY = 'GHS';

/*
|--------------------------------------------------------------------------
| Helper: Generate unique payment reference
|--------------------------------------------------------------------------
*/
function generateReference() {
    return `SMS-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
}

/*
|--------------------------------------------------------------------------
| Helper: Fulfill successful subscription payment
|--------------------------------------------------------------------------
*/
async function fulfillSubscriptionPayment(reference, paystackData) {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        /*
        |--------------------------------------------------------------------------
        | Lock the payment row so webhook + verify cannot fulfill twice
        |--------------------------------------------------------------------------
        */
        const [transactions] = await connection.query(
            `SELECT *
             FROM payment_transactions
             WHERE reference = ?
             FOR UPDATE`,
            [reference]
        );

        if (transactions.length === 0) {
            throw new Error(`Payment transaction not found: ${reference}`);
        }

        const transaction = transactions[0];

        /*
        |--------------------------------------------------------------------------
        | Idempotency
        |--------------------------------------------------------------------------
        */
        if (transaction.status === 'success') {
            await connection.commit();

            return {
                alreadyProcessed: true,
                schoolId: transaction.school_id
            };
        }

        /*
        |--------------------------------------------------------------------------
        | Security checks
        |--------------------------------------------------------------------------
        */
        if (Number(paystackData.amount) !== MONTHLY_AMOUNT) {
            throw new Error('Payment amount mismatch.');
        }

        if (String(paystackData.currency).toUpperCase() !== CURRENCY) {
            throw new Error('Payment currency mismatch.');
        }

        if (paystackData.status !== 'success') {
            throw new Error(`Payment was not successful. Status: ${paystackData.status}`);
        }

        /*
        |--------------------------------------------------------------------------
        | Mark transaction successful
        |--------------------------------------------------------------------------
        */
        await connection.query(
            `UPDATE payment_transactions
             SET status = 'success',
                 paystack_transaction_id = ?,
                 paid_at = NOW()
             WHERE reference = ?`,
            [
                String(paystackData.id),
                reference
            ]
        );

        /*
        |--------------------------------------------------------------------------
        | Get school's current subscription
        |--------------------------------------------------------------------------
        */
        const [schools] = await connection.query(
            `SELECT id,
                    sub_status,
                    subscription_start_date,
                    subscription_end_date
             FROM schools
             WHERE id = ?
             FOR UPDATE`,
            [transaction.school_id]
        );

        if (schools.length === 0) {
            throw new Error(`School not found: ${transaction.school_id}`);
        }

        const school = schools[0];

        /*
        |--------------------------------------------------------------------------
        | Extend subscription
        |
        | If the school is still active:
        |     current expiry + 30 days
        |
        | If already expired:
        |     now + 30 days
        |--------------------------------------------------------------------------
        */
        await connection.query(
            `UPDATE schools
             SET sub_status = 'active',
                 subscription_plan = 'monthly',
                 subscription_start_date =
                     CASE
                         WHEN subscription_end_date IS NULL
                              OR subscription_end_date < NOW()
                         THEN NOW()
                         ELSE subscription_start_date
                     END,
                 subscription_end_date =
                     CASE
                         WHEN subscription_end_date IS NULL
                              OR subscription_end_date < NOW()
                         THEN DATE_ADD(NOW(), INTERVAL 30 DAY)
                         ELSE DATE_ADD(subscription_end_date, INTERVAL 30 DAY)
                     END
             WHERE id = ?`,
            [transaction.school_id]
        );

        await connection.commit();

        return {
            alreadyProcessed: false,
            schoolId: transaction.school_id
        };

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/*
|--------------------------------------------------------------------------
| POST /api/payments/initialize
|
| Authenticated school admin initializes ₵100 payment
|--------------------------------------------------------------------------
*/
router.post('/initialize', verifyToken, async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            return res.status(500).json({
                message: 'PAYSTACK_SECRET_KEY is not configured on the server.'
            });
        }

        const schoolId = req.user.school_id;
        const userId = req.user.id;

        /*
        |--------------------------------------------------------------------------
        | Only admins should initiate school subscription payments
        |--------------------------------------------------------------------------
        */
        if (req.user.role !== 'admin') {
            return res.status(403).json({
                message: 'Only school administrators can make subscription payments.'
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Get admin email + school
        |--------------------------------------------------------------------------
        */
        const [users] = await db.query(
            `SELECT id, email, full_name, school_id
             FROM users
             WHERE id = ?
               AND school_id = ?`,
            [userId, schoolId]
        );

        if (users.length === 0) {
            return res.status(404).json({
                message: 'Admin account not found.'
            });
        }

        const user = users[0];

        const [schools] = await db.query(
            `SELECT id, school_name
             FROM schools
             WHERE id = ?`,
            [schoolId]
        );

        if (schools.length === 0) {
            return res.status(404).json({
                message: 'School not found.'
            });
        }

        const school = schools[0];

        /*
        |--------------------------------------------------------------------------
        | Generate unique reference
        |--------------------------------------------------------------------------
        */
        const reference = generateReference();

        /*
        |--------------------------------------------------------------------------
        | Initialize transaction with Paystack
        |--------------------------------------------------------------------------
        */
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: user.email,
                amount: String(MONTHLY_AMOUNT),
                currency: CURRENCY,
                reference,
                callback_url: `${FRONTEND_URL}/billing`,
                metadata: JSON.stringify({
                    school_id: schoolId,
                    user_id: userId,
                    school_name: school.school_name,
                    payment_type: 'subscription',
                    plan: 'monthly'
                })
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!paystackResponse.data.status) {
            return res.status(400).json({
                message: 'Unable to initialize Paystack payment.'
            });
        }

        const paymentData = paystackResponse.data.data;

        /*
        |--------------------------------------------------------------------------
        | Save pending transaction
        |--------------------------------------------------------------------------
        */
        await db.query(
            `INSERT INTO payment_transactions
             (
                 school_id,
                 reference,
                 amount,
                 currency,
                 status,
                 payment_type
             )
             VALUES (?, ?, ?, ?, 'pending', 'subscription')`,
            [
                schoolId,
                paymentData.reference,
                MONTHLY_AMOUNT,
                CURRENCY
            ]
        );

        return res.json({
            success: true,
            message: 'Payment initialized successfully.',
            authorization_url: paymentData.authorization_url,
            access_code: paymentData.access_code,
            reference: paymentData.reference
        });

    } catch (error) {
        console.error(
            'Paystack initialization error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            message: 'Unable to initialize payment.',
            error: error.response?.data?.message || error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| GET /api/payments/verify/:reference
|
| Authenticated verification endpoint
|--------------------------------------------------------------------------
*/
router.get('/verify/:reference', verifyToken, async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            return res.status(500).json({
                message: 'PAYSTACK_SECRET_KEY is not configured on the server.'
            });
        }

        const { reference } = req.params;
        const schoolId = req.user.school_id;

        /*
        |--------------------------------------------------------------------------
        | Make sure reference belongs to this school
        |--------------------------------------------------------------------------
        */
        const [transactions] = await db.query(
            `SELECT *
             FROM payment_transactions
             WHERE reference = ?
               AND school_id = ?`,
            [reference, schoolId]
        );

        if (transactions.length === 0) {
            return res.status(404).json({
                message: 'Payment transaction not found.'
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Ask Paystack for authoritative transaction status
        |--------------------------------------------------------------------------
        */
        const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        if (!paystackResponse.data.status) {
            return res.status(400).json({
                message: 'Paystack verification failed.'
            });
        }

        const payment = paystackResponse.data.data;

        /*
        |--------------------------------------------------------------------------
        | Successful payment
        |--------------------------------------------------------------------------
        */
        if (payment.status === 'success') {
            const result = await fulfillSubscriptionPayment(
                reference,
                payment
            );

            return res.json({
                success: true,
                paid: true,
                message: result.alreadyProcessed
                    ? 'Payment was already processed.'
                    : 'Payment verified and subscription activated.'
            });
        }

        /*
        |--------------------------------------------------------------------------
        | Payment not successful
        |--------------------------------------------------------------------------
        */
        await db.query(
            `UPDATE payment_transactions
             SET status = 'failed'
             WHERE reference = ?
               AND status = 'pending'`,
            [reference]
        );

        return res.json({
            success: true,
            paid: false,
            status: payment.status,
            message: `Payment status: ${payment.status}`
        });

    } catch (error) {
        console.error(
            'Paystack verification error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            message: 'Unable to verify payment.',
            error: error.response?.data?.message || error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| POST /api/payments/webhook
|
| PUBLIC ROUTE
| Paystack calls this directly
|--------------------------------------------------------------------------
*/
router.post('/webhook', async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            console.error('PAYSTACK_SECRET_KEY is missing.');
            return res.sendStatus(500);
        }

        const signature = req.headers['x-paystack-signature'];

        if (!signature) {
            console.warn('Paystack webhook missing signature.');
            return res.sendStatus(401);
        }

        /*
        |--------------------------------------------------------------------------
        | Verify webhook signature
        |--------------------------------------------------------------------------
        */
        const rawBody = req.rawBody;

        if (!rawBody) {
            console.error('Webhook raw body is missing.');
            return res.sendStatus(400);
        }

        const expectedSignature = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(rawBody)
            .digest('hex');

        const signaturesMatch =
            signature.length === expectedSignature.length &&
            crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expectedSignature)
            );

        if (!signaturesMatch) {
            console.warn('Invalid Paystack webhook signature.');
            return res.sendStatus(401);
        }

        const event = req.body;

        console.log('Paystack webhook received:', event.event);

        /*
        |--------------------------------------------------------------------------
        | We currently care about successful charges
        |--------------------------------------------------------------------------
        */
        if (event.event !== 'charge.success') {
            return res.sendStatus(200);
        }

        const payment = event.data;

        if (!payment || !payment.reference) {
            console.error('Webhook missing payment reference.');
            return res.sendStatus(400);
        }

        /*
        |--------------------------------------------------------------------------
        | Make sure this is one of OUR subscription transactions
        |--------------------------------------------------------------------------
        */
        const [transactions] = await db.query(
            `SELECT *
             FROM payment_transactions
             WHERE reference = ?`,
            [payment.reference]
        );

        if (transactions.length === 0) {
            console.warn(
                `No local transaction found for reference ${payment.reference}`
            );

            /*
            Paystack expects a 200 acknowledgement.
            We do not create arbitrary transactions from webhook data.
            */
            return res.sendStatus(200);
        }

        /*
        |--------------------------------------------------------------------------
        | Fulfill payment
        |--------------------------------------------------------------------------
        */
        await fulfillSubscriptionPayment(
            payment.reference,
            payment
        );

        console.log(
            `Subscription payment processed: ${payment.reference}`
        );

        return res.sendStatus(200);

    } catch (error) {
        console.error(
            'Paystack webhook error:',
            error.response?.data || error.message
        );

        return res.sendStatus(500);
    }
});

/*
|--------------------------------------------------------------------------
| GET /api/payments/subscription
|
| Get current school's subscription status
|--------------------------------------------------------------------------
*/
router.get('/subscription', verifyToken, async (req, res) => {
    try {
        const schoolId = req.user.school_id;

        const [schools] = await db.query(
            `SELECT
                id,
                school_name,
                sub_status,
                subscription_plan,
                subscription_start_date,
                subscription_end_date
             FROM schools
             WHERE id = ?`,
            [schoolId]
        );

        if (schools.length === 0) {
            return res.status(404).json({
                message: 'School not found.'
            });
        }

        const school = schools[0];

        const now = new Date();

        let effectiveStatus = school.sub_status;

        if (
            school.subscription_end_date &&
            new Date(school.subscription_end_date) < now
        ) {
            effectiveStatus = 'expired';
        }

        return res.json({
            success: true,
            subscription: {
                school_name: school.school_name,
                status: effectiveStatus,
                plan: school.subscription_plan,
                start_date: school.subscription_start_date,
                end_date: school.subscription_end_date,
                monthly_amount: MONTHLY_AMOUNT,
                currency: CURRENCY
            }
        });

    } catch (error) {
        console.error('Subscription status error:', error);

        return res.status(500).json({
            message: 'Unable to retrieve subscription status.'
        });
    }
});

/*
|--------------------------------------------------------------------------
| GET /api/payments/history
|
| Payment history for the logged-in school
|--------------------------------------------------------------------------
*/
router.get('/history', verifyToken, async (req, res) => {
    try {
        const schoolId = req.user.school_id;

        const [payments] = await db.query(
            `SELECT
                id,
                reference,
                amount,
                currency,
                status,
                payment_type,
                paystack_transaction_id,
                paid_at,
                created_at
             FROM payment_transactions
             WHERE school_id = ?
             ORDER BY created_at DESC`,
            [schoolId]
        );

        return res.json({
            success: true,
            payments
        });

    } catch (error) {
        console.error('Payment history error:', error);

        return res.status(500).json({
            message: 'Unable to retrieve payment history.'
        });
    }
});

module.exports = router;