const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const router = express.Router();
const crypto = require('crypto');


const {
    TERMS_VERSION,
    SERVICE_VERSION,
    TERMS_TEXT,
    SERVICE_TEXT,
    hashText
} = require('../utils/agreementDocuments');








// Return the authoritative agreement documents shown during registration.
router.get('/agreements', (req, res) => {
    res.set('Cache-Control', 'no-store');

    return res.status(200).json({
        documents: {
            terms: {
                version: TERMS_VERSION,
                text: TERMS_TEXT,
                hash: hashText(TERMS_TEXT)
            },
            service_agreement: {
                version: SERVICE_VERSION,
                text: SERVICE_TEXT,
                hash: hashText(SERVICE_TEXT)
            }
        }
    });
});






router.post('/register', async (req, res) => {
    const {
    school_name,
    admin_name,
    email,
    password,
    invitation_code,
    signature_name,
    terms_accepted,
    service_agreement_accepted,
    authority_confirmed,
    terms_version,
    terms_hash,
    service_agreement_version,
    service_agreement_hash
} = req.body;

    // 1. Validate required fields
    if (
        typeof school_name !== 'string' ||
        !school_name.trim() ||
        typeof admin_name !== 'string' ||
        !admin_name.trim() ||
        typeof email !== 'string' ||
        !email.trim() ||
        typeof password !== 'string' ||
        !password ||
        typeof invitation_code !== 'string' ||
        !invitation_code.trim()
    ) {
        return res.status(400).json({
            message: 'School name, administrator name, email, password, and invitation code are required.'
        });
    }
    // Validate agreement acceptance and electronic signature.
if (
    typeof signature_name !== 'string' ||
    !signature_name.trim() ||
    terms_accepted !== true ||
    service_agreement_accepted !== true ||
    authority_confirmed !== true
) {
    return res.status(400).json({
        message:
            'You must accept both documents, provide your full name as your electronic signature, and confirm your authority to represent the school.'
    });
}
// Require acceptance of the exact current agreement versions.
if (
    terms_version !== TERMS_VERSION ||
    terms_hash !== hashText(TERMS_TEXT) ||
    service_agreement_version !== SERVICE_VERSION ||
    service_agreement_hash !== hashText(SERVICE_TEXT)
) {
    return res.status(409).json({
        message:
            'The agreement documents have changed or could not be verified. Reload the registration page, review the current documents, and accept them again.'
    });
}


const normalizedSignatureName = signature_name.trim();

    const normalizedSchoolName = school_name.trim();
    const normalizedAdminName = admin_name.trim();
    const normalizedEmail = email.trim().toLowerCase();

    // 2. Hash the invitation code for database lookup
    const codeHash = crypto
        .createHash('sha256')
        .update(invitation_code.trim())
        .digest('hex');

    // Hash the password before opening the transaction
    let hashedPassword;

    try {
        const salt = await bcrypt.genSalt(10);
        hashedPassword = await bcrypt.hash(password, salt);
    } catch (error) {
        console.error('Password hashing error:', error);

        return res.status(500).json({
            message: 'Unable to process registration.'
        });
    }

    let connection;
    let transactionStarted = false;

    try {
        connection = await db.getConnection();

        await connection.beginTransaction();
        transactionStarted = true;

        // 3. Lock the invitation row to prevent concurrent reuse
        const [invitationRows] = await connection.query(
            `SELECT
                id,
                intended_school_name,
                expires_at,
                used_at,
                (expires_at <= UTC_TIMESTAMP()) AS is_expired
             FROM school_registration_invitations
             WHERE code_hash = ?
             LIMIT 1
             FOR UPDATE`,
            [codeHash]
        );

        if (invitationRows.length === 0) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(403).json({
                message: 'Invalid invitation code.'
            });
        }

        const invitation = invitationRows[0];

        if (invitation.used_at !== null) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(403).json({
                message: 'This invitation has already been used.'
            });
        }

        if (Number(invitation.is_expired) === 1) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(403).json({
                message: 'This invitation has expired. Contact the system administrator.'
            });
        }

        // 4. Ensure the invitation belongs to this school
        const intendedSchoolName =
            String(invitation.intended_school_name).trim().toLowerCase();

        if (
            normalizedSchoolName.toLowerCase() !== intendedSchoolName
        ) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(403).json({
                message: 'This invitation is not assigned to the supplied school name.'
            });
        }

        // 5. Check whether the administrator email already exists
        const [existingUsers] = await connection.query(
            'SELECT id FROM users WHERE email = ? LIMIT 1',
            [normalizedEmail]
        );

        if (existingUsers.length > 0) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(400).json({
                message: 'Email already in use.'
            });
        }

        // 6. Lock the counter so simultaneous registrations
        // cannot receive the same school admission code
        const [counterRows] = await connection.query(
            `SELECT last_code
             FROM school_admission_code_counter
             WHERE counter_name = ?
             FOR UPDATE`,
            ['global']
        );

        if (counterRows.length === 0) {
            throw new Error(
                'School admission-code counter is missing.'
            );
        }

        const nextCode = Number(counterRows[0].last_code) + 1;

        if (nextCode > 9999) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message: 'The school-code limit has been reached. Contact the system administrator.'
            });
        }

        const admissionCode = String(nextCode).padStart(4, '0');

        // 7. Advance the counter inside the transaction
        await connection.query(
            `UPDATE school_admission_code_counter
             SET last_code = ?
             WHERE counter_name = ?`,
            [nextCode, 'global']
        );

        // 8. Create the school
        const [schoolResult] = await connection.query(
            `INSERT INTO schools
                (school_name, sub_status, admission_code)
             VALUES (?, ?, ?)`,
            [
                normalizedSchoolName,
                'trial',
                admissionCode
            ]
        );

        const schoolId = schoolResult.insertId;

        // 9. Create the administrator account
       const [adminResult] = await connection.query(
    `INSERT INTO users
        (school_id, full_name, email, password_hash, role)
     VALUES (?, ?, ?, ?, ?)`,
    [
        schoolId,
        normalizedAdminName,
        normalizedEmail,
        hashedPassword,
        'admin'
    ]
);

const adminId = adminResult.insertId;


// Preserve a separate acceptance record for each document.
// These inserts run inside the existing registration transaction.
const acceptedDocuments = [
    {
        version: TERMS_VERSION,
        text: TERMS_TEXT
    },
    {
        version: SERVICE_VERSION,
        text: SERVICE_TEXT
    }
];

for (const document of acceptedDocuments) {
    await connection.query(
        `INSERT INTO service_agreement_acceptances (
            school_id,
            user_id,
            signatory_full_name,
            agreement_version,
            agreement_text,
            agreement_hash,
            terms_accepted,
            authority_confirmed,
            accepted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [
            schoolId,
            adminId,
            normalizedSignatureName,
            document.version,
            document.text,
            hashText(document.text),
            true,
            true
        ]
    );
}





        // 10. Mark the invitation as used.
        // This happens inside the same transaction as registration.
        const [usedResult] = await connection.query(
            `UPDATE school_registration_invitations
             SET used_at = UTC_TIMESTAMP()
             WHERE id = ?
               AND used_at IS NULL
               AND expires_at > UTC_TIMESTAMP()`,
            [invitation.id]
        );

        if (usedResult.affectedRows !== 1) {
            throw new Error(
                'Invitation could not be consumed safely.'
            );
        }

        // 11. Commit everything together
        await connection.commit();
        transactionStarted = false;

       return res.status(201).json({
    message: 'School and administrator registered successfully!',
    school: {
        id: schoolId,
        name: normalizedSchoolName,
        admission_code: admissionCode
    },
    administrator: {
        id: adminId,
        name: normalizedAdminName,
        email: normalizedEmail
    },
    agreement_acceptance: {
        recorded: true,
        documents: [
            TERMS_VERSION,
            SERVICE_VERSION
        ]
    }
});

    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    'Registration rollback error:',
                    rollbackError
                );
            }
        }

        console.error('School registration error:', error);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                message: 'This email or school admission code is already in use. Please retry or use another email.'
            });
        }

        return res.status(500).json({
            message: 'Server error during registration.'
        });

    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// --- LOGIN ENDPOINT ---
// --- LOGIN ENDPOINT ---
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1. Check if the user exists based ONLY on their email
        const query = 'SELECT * FROM users WHERE email = ?';
        const [users] = await db.query(query, [email]);
        
        if (users.length === 0) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        const user = users[0]; // We found the user! Now we know their school_id.

        // 2. Compare the typed password with the hashed password in the DB
        const isMatch = await bcrypt.compare(password, user.password_hash);
        
        if (!isMatch) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        // 3. Generate the "Digital ID Card" (JWT)
        // We grab the school_id directly from the database record we just found
        const payload = {
            id: user.id,
            school_id: user.school_id, 
            role: user.role
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET || 'your_secret_key', { expiresIn: '1d' });
        
        // 4. Send it back to the frontend
        res.json({ token, message: "Login successful" });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Server error during login" });
    }
});









// =====================================================
// ADD TEACHER
// =====================================================
router.post('/add-teacher', async (req, res) => {
    const { full_name, email, password, school_id } = req.body;

    if (!full_name || !email || !password || !school_id) {
        return res.status(400).json({
            message: 'Full name, email, password and school ID are required.'
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Check if email already exists
        const [existingUsers] = await connection.execute(
            'SELECT id FROM users WHERE email = ?',
            [email]
        );

        if (existingUsers.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                message: 'A user with this email already exists.'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // 1. Create login account
        const [userResult] = await connection.execute(
            `INSERT INTO users
            (full_name, email, password_hash, school_id, role)
            VALUES (?, ?, ?, ?, 'teacher')`,
            [full_name, email, hashedPassword, school_id]
        );

        // 2. Create teacher profile
        const [teacherResult] = await connection.execute(
            `INSERT INTO teachers
            (school_id, full_name, email, password)
            VALUES (?, ?, ?, ?)`,
            [school_id, full_name, email, hashedPassword]
        );

        await connection.commit();

        res.status(201).json({
            message: 'Teacher added successfully.',
            teacher: {
                id: teacherResult.insertId,
                user_id: userResult.insertId,
                school_id,
                full_name,
                email
            }
        });

    } catch (error) {
        await connection.rollback();

        console.error('Error creating teacher:', error);

        res.status(500).json({
            message: 'Database error while creating teacher.',
            error: error.message
        });
    } finally {
        connection.release();
    }
});


// =====================================================
// GET ALL TEACHERS FOR A SCHOOL
// =====================================================
router.get('/teachers/:school_id', async (req, res) => {
    const { school_id } = req.params;

    try {
        const [teachers] = await db.execute(
            `SELECT id, school_id, full_name, email
             FROM teachers
             WHERE school_id = ?
             ORDER BY full_name ASC`,
            [school_id]
        );

        res.json(teachers);

    } catch (error) {
        console.error('Error fetching teachers:', error);

        res.status(500).json({
            message: 'Failed to fetch teachers.'
        });
    }
});





// =====================================================
// ASSIGN TEACHER TO CLASS + SUBJECT
// =====================================================
router.post('/assign-teacher', async (req, res) => {

    const {
        teacher_id,
        class_id,
        subject_id
    } = req.body;

    if (!teacher_id || !class_id || !subject_id) {
        return res.status(400).json({
            message: 'Teacher, class and subject are required.'
        });
    }

    try {

        // -------------------------------------------------
        // GET TEACHER + SCHOOL
        // -------------------------------------------------

        const [teachers] = await db.execute(
            `
            SELECT
                id,
                school_id,
                full_name
            FROM teachers
            WHERE id = ?
            LIMIT 1
            `,
            [teacher_id]
        );

        if (teachers.length === 0) {
            return res.status(404).json({
                message: 'Teacher not found.'
            });
        }

        const teacher = teachers[0];

        // -------------------------------------------------
        // CHECK CLASS BELONGS TO SAME SCHOOL
        // -------------------------------------------------

        const [classes] = await db.execute(
            `
            SELECT
                id,
                school_id,
                class_name
            FROM school_classes
            WHERE id = ?
            AND school_id = ?
            LIMIT 1
            `,
            [class_id, teacher.school_id]
        );

        if (classes.length === 0) {
            return res.status(400).json({
                message: 'Selected class does not belong to this school.'
            });
        }

        // -------------------------------------------------
        // CHECK SUBJECT BELONGS TO SAME SCHOOL
        // -------------------------------------------------

        const [subjects] = await db.execute(
            `
            SELECT
                id,
                school_id,
                subject_name
            FROM school_subjects
            WHERE id = ?
            AND school_id = ?
            LIMIT 1
            `,
            [subject_id, teacher.school_id]
        );

        if (subjects.length === 0) {
            return res.status(400).json({
                message: 'Selected subject does not belong to this school.'
            });
        }

        // -------------------------------------------------
        // PREVENT DUPLICATE ASSIGNMENT
        // -------------------------------------------------

        const [existing] = await db.execute(
            `
            SELECT id
            FROM teacher_assignments
            WHERE teacher_id = ?
            AND class_id = ?
            AND subject_id = ?
            LIMIT 1
            `,
            [
                teacher_id,
                class_id,
                subject_id
            ]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: 'This teacher is already assigned to this class and subject.'
            });
        }

        // -------------------------------------------------
        // CREATE ASSIGNMENT
        // -------------------------------------------------

        await db.execute(
            `
            INSERT INTO teacher_assignments
            (
                teacher_id,
                class_id,
                subject_id
            )
            VALUES (?, ?, ?)
            `,
            [
                teacher_id,
                class_id,
                subject_id
            ]
        );

        res.status(201).json({
            message: 'Teacher assigned successfully.'
        });

    } catch (error) {

        console.error(
            'Error assigning teacher:',
            error
        );

        res.status(500).json({
            message: 'Failed to assign teacher.',
            error: error.message
        });
    }
});

// =====================================================
// GET ASSIGNMENTS FOR ONE TEACHER
// =====================================================
router.get('/teacher-assignments/:teacher_id', async (req, res) => {

    const { teacher_id } = req.params;

    try {

        const [assignments] = await db.execute(
            `
            SELECT
                ta.id,
                ta.teacher_id,
                c.id AS class_id,
                c.class_name,
                s.id AS subject_id,
                s.subject_name
            FROM teacher_assignments ta

            INNER JOIN school_classes c
                ON ta.class_id = c.id

            INNER JOIN school_subjects s
                ON ta.subject_id = s.id

            WHERE ta.teacher_id = ?

            ORDER BY
                c.class_name,
                s.subject_name
            `,
            [teacher_id]
        );

        res.json(assignments);

    } catch (error) {

        console.error(
            'Error fetching teacher assignments:',
            error
        );

        res.status(500).json({
            message: 'Failed to fetch teacher assignments.'
        });
    }
});


// =====================================================
// GET ALL TEACHER ASSIGNMENTS FOR A SCHOOL
// =====================================================
router.get('/all-teacher-assignments/:school_id', async (req, res) => {

    const { school_id } = req.params;

    try {

        const [assignments] = await db.execute(
            `
            SELECT
                ta.id,
                ta.teacher_id,

                t.full_name AS teacher_name,
                t.email,

                sc.id AS class_id,
                sc.class_name,

                ss.id AS subject_id,
                ss.subject_name

            FROM teacher_assignments ta

            INNER JOIN teachers t
                ON ta.teacher_id = t.id

            INNER JOIN school_classes sc
                ON ta.class_id = sc.id
                AND sc.school_id = t.school_id

            INNER JOIN school_subjects ss
                ON ta.subject_id = ss.id
                AND ss.school_id = t.school_id

            WHERE t.school_id = ?

            ORDER BY
                t.full_name,
                sc.class_name,
                ss.subject_name
            `,
            [school_id]
        );

        res.json(assignments);

    } catch (error) {

        console.error(
            'Error fetching all teacher assignments:',
            error
        );

        res.status(500).json({
            message: 'Failed to fetch teacher assignments.'
        });
    }
});





// =====================================================
// DELETE TEACHER ASSIGNMENT
// =====================================================
router.delete('/teacher-assignment/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const [result] = await db.execute(
            `DELETE FROM teacher_assignments
             WHERE id = ?`,
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: 'Assignment not found.'
            });
        }

        res.json({
            message: 'Teacher assignment removed successfully.'
        });

    } catch (error) {
        console.error('Error deleting teacher assignment:', error);

        res.status(500).json({
            message: 'Failed to remove teacher assignment.'
        });
    }
});


// =====================================================
// GET LOGGED-IN TEACHER PROFILE + ASSIGNMENTS
// =====================================================

router.get('/teacher/me', async (req, res) => {
    try {

        // -------------------------------------------------
        // CHECK AUTHORIZATION HEADER
        // -------------------------------------------------

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: 'Authentication required.'
            });
        }

        const token = authHeader.split(' ')[1];

        // -------------------------------------------------
        // VERIFY JWT
        // -------------------------------------------------

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET || 'your_secret_key'
        );

        if (decoded.role !== 'teacher') {
            return res.status(403).json({
                message: 'Teacher access only.'
            });
        }

        // -------------------------------------------------
        // GET USER ACCOUNT
        // -------------------------------------------------

        const [users] = await db.execute(
            `
            SELECT
                id,
                school_id,
                full_name,
                email,
                role
            FROM users
            WHERE id = ?
            AND role = 'teacher'
            LIMIT 1
            `,
            [decoded.id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                message: 'Teacher account not found.'
            });
        }

        const user = users[0];

        // -------------------------------------------------
        // GET TEACHER PROFILE
        // -------------------------------------------------

        const [teachers] = await db.execute(
            `
            SELECT
                id,
                school_id,
                full_name,
                email
            FROM teachers
            WHERE email = ?
            AND school_id = ?
            LIMIT 1
            `,
            [
                user.email,
                user.school_id
            ]
        );

        if (teachers.length === 0) {
            return res.status(404).json({
                message: 'Teacher profile not found.'
            });
        }

        const teacher = teachers[0];

        // -------------------------------------------------
        // GET TEACHER ASSIGNMENTS
        // -------------------------------------------------

      const [assignments] = await db.execute(
    `
    SELECT
        ta.id,
        ta.teacher_id,

        sc.id AS class_id,
        sc.class_name,

        ss.id AS subject_id,
        ss.subject_name

    FROM teacher_assignments ta

    INNER JOIN school_classes sc
        ON ta.class_id = sc.id

    INNER JOIN school_subjects ss
        ON ta.subject_id = ss.id

    WHERE ta.teacher_id = ?

    ORDER BY
        sc.class_name ASC,
        ss.subject_name ASC
    `,
    [teacher.id]
);

        // -------------------------------------------------
        // RETURN TEACHER + ASSIGNMENTS
        // -------------------------------------------------

        res.json({
            teacher: {
                id: teacher.id,
                user_id: user.id,
                school_id: teacher.school_id,
                full_name: teacher.full_name,
                email: teacher.email
            },
            assignments
        });

    } catch (error) {

        console.error(
            'Error loading teacher profile:',
            error
        );

        if (
            error.name === 'JsonWebTokenError' ||
            error.name === 'TokenExpiredError'
        ) {
            return res.status(401).json({
                message: 'Invalid or expired token.'
            });
        }

        res.status(500).json({
            message: 'Failed to load teacher dashboard.'
        });
    }
});



// =====================================================
// SCHOOL CLASSES
// =====================================================

// Add a class
router.post('/classes', async (req, res) => {
    try {
        const { school_id, class_name } = req.body;

        if (!school_id || !class_name) {
            return res.status(400).json({
                message: 'School ID and class name are required.'
            });
        }

        const [existing] = await db.execute(
            `
            SELECT id
            FROM school_classes
            WHERE school_id = ?
            AND class_name = ?
            LIMIT 1
            `,
            [school_id, class_name.trim()]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: 'This class already exists.'
            });
        }

        const [result] = await db.execute(
            `
            INSERT INTO school_classes
            (school_id, class_name)
            VALUES (?, ?)
            `,
            [school_id, class_name.trim()]
        );

        res.status(201).json({
            message: 'Class added successfully.',
            class: {
                id: result.insertId,
                school_id,
                class_name: class_name.trim()
            }
        });

    } catch (error) {
        console.error('Error adding class:', error);

        res.status(500).json({
            message: 'Failed to add class.'
        });
    }
});


// Get all classes for a school
router.get('/classes/:school_id', async (req, res) => {
    try {
        const { school_id } = req.params;

        const [classes] = await db.execute(
            `
            SELECT
                id,
                school_id,
                class_name,
                created_at
            FROM school_classes
            WHERE school_id = ?
            ORDER BY class_name ASC
            `,
            [school_id]
        );

        res.json(classes);

    } catch (error) {
        console.error('Error loading classes:', error);

        res.status(500).json({
            message: 'Failed to load classes.'
        });
    }
});


// Delete a class
router.delete('/classes/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [result] = await db.execute(
            `
            DELETE FROM school_classes
            WHERE id = ?
            `,
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: 'Class not found.'
            });
        }

        res.json({
            message: 'Class deleted successfully.'
        });

    } catch (error) {
        console.error('Error deleting class:', error);

        res.status(500).json({
            message: 'Failed to delete class.'
        });
    }
});



// =====================================================
// SCHOOL SUBJECTS
// =====================================================

// Add a subject
router.post('/subjects', async (req, res) => {
    try {
        const { school_id, subject_name } = req.body;

        if (!school_id || !subject_name) {
            return res.status(400).json({
                message: 'School ID and subject name are required.'
            });
        }

        const [existing] = await db.execute(
            `
            SELECT id
            FROM school_subjects
            WHERE school_id = ?
            AND subject_name = ?
            LIMIT 1
            `,
            [school_id, subject_name.trim()]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: 'This subject already exists.'
            });
        }

        const [result] = await db.execute(
            `
            INSERT INTO school_subjects
            (school_id, subject_name)
            VALUES (?, ?)
            `,
            [school_id, subject_name.trim()]
        );

        res.status(201).json({
            message: 'Subject added successfully.',
            subject: {
                id: result.insertId,
                school_id,
                subject_name: subject_name.trim()
            }
        });

    } catch (error) {
        console.error('Error adding subject:', error);

        res.status(500).json({
            message: 'Failed to add subject.'
        });
    }
});


// Get all subjects for a school
router.get('/subjects/:school_id', async (req, res) => {
    try {
        const { school_id } = req.params;

        const [subjects] = await db.execute(
            `
            SELECT
                id,
                school_id,
                subject_name,
                created_at
            FROM school_subjects
            WHERE school_id = ?
            ORDER BY subject_name ASC
            `,
            [school_id]
        );

        res.json(subjects);

    } catch (error) {
        console.error('Error loading subjects:', error);

        res.status(500).json({
            message: 'Failed to load subjects.'
        });
    }
});


// Delete a subject
router.delete('/subjects/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [result] = await db.execute(
            `
            DELETE FROM school_subjects
            WHERE id = ?
            `,
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: 'Subject not found.'
            });
        }

        res.json({
            message: 'Subject deleted successfully.'
        });

    } catch (error) {
        console.error('Error deleting subject:', error);

        res.status(500).json({
            message: 'Failed to delete subject.'
        });
    }
});





// SYSTEM OWNER AUTHENTICATION MIDDLEWARE
async function requireSystemOwner(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: 'System Owner authentication required.'
            });
        }

        const token = authHeader.split(' ')[1];

        if (!process.env.JWT_SECRET) {
            return res.status(500).json({
                message: 'Authentication is not configured.'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (
            decoded.type !== 'system_owner' ||
            decoded.role !== 'system_owner' ||
            !decoded.id
        ) {
            return res.status(403).json({
                message: 'Access denied. System Owner privileges required.'
            });
        }

        const [owners] = await db.execute(
            `SELECT id
             FROM system_owners
             WHERE id = ? AND is_active = TRUE
             LIMIT 1`,
            [decoded.id]
        );

        if (owners.length === 0) {
            return res.status(403).json({
                message: 'System Owner account is inactive or unavailable.'
            });
        }

        req.systemOwner = {
            id: owners[0].id
        };

        next();

    } catch (error) {
        if (
            error.name === 'JsonWebTokenError' ||
            error.name === 'TokenExpiredError'
        ) {
            return res.status(401).json({
                message: 'Invalid or expired authentication token.'
            });
        }

        console.error('System Owner authentication error:', error);

        return res.status(500).json({
            message: 'Authentication failed.'
        });
    }
}





// SYSTEM OWNER LOGIN
router.post('/owner/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required.'
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const [owners] = await db.execute(
            `SELECT id, full_name, email, password_hash, is_active
             FROM system_owners
             WHERE email = ?
             LIMIT 1`,
            [normalizedEmail]
        );

        if (owners.length === 0) {
            return res.status(401).json({
                message: 'Invalid email or password.'
            });
        }

        const owner = owners[0];

        if (!owner.is_active) {
            return res.status(403).json({
                message: 'This System Owner account is inactive.'
            });
        }

        const passwordMatches = await bcrypt.compare(
            password,
            owner.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                message: 'Invalid email or password.'
            });
        }

        if (!process.env.JWT_SECRET) {
            console.error('JWT_SECRET is not configured.');

            return res.status(500).json({
                message: 'Authentication is not configured.'
            });
        }

        const token = jwt.sign(
            {
                id: owner.id,
                role: 'system_owner',
                type: 'system_owner'
            },
            process.env.JWT_SECRET,
            { expiresIn: '2h' }
        );

        return res.status(200).json({
            message: 'System Owner login successful.',
            token,
            owner: {
                id: owner.id,
                full_name: owner.full_name,
                email: owner.email
            }
        });

    } catch (error) {
        console.error('System Owner login error:', error);

        return res.status(500).json({
            message: 'An error occurred during login.'
        });
    }
});













// ==========================================
// SYSTEM OWNER: GENERATE SCHOOL INVITATION
// ==========================================
router.post(
    '/owner/invitations',
    requireSystemOwner,
    async (req, res) => {
        try {
            const { intended_school_name, expires_in_hours = 168 } = req.body;

            if (
                typeof intended_school_name !== 'string' ||
                !intended_school_name.trim()
            ) {
                return res.status(400).json({
                    message: 'School name is required.'
                });
            }

            const schoolName = intended_school_name.trim();

            if (schoolName.length > 255) {
                return res.status(400).json({
                    message: 'School name cannot exceed 255 characters.'
                });
            }

            const hours = Number(expires_in_hours);

            if (
                !Number.isInteger(hours) ||
                hours < 1 ||
                hours > 720
            ) {
                return res.status(400).json({
                    message: 'Expiration must be between 1 and 720 hours.'
                });
            }

            // Generate a cryptographically secure, unpredictable code.
            const invitationCode = crypto
                .randomBytes(32)
                .toString('hex');

            // Store only the SHA-256 hash, never the original code.
            const codeHash = crypto
                .createHash('sha256')
                .update(invitationCode)
                .digest('hex');

            // Store expiration as a UTC datetime.
            const expiresAt = new Date(
                Date.now() + hours * 60 * 60 * 1000
            )
                .toISOString()
                .slice(0, 19)
                .replace('T', ' ');

            await db.execute(
                `INSERT INTO school_registration_invitations
                    (code_hash, intended_school_name, expires_at)
                 VALUES (?, ?, ?)`,
                [codeHash, schoolName, expiresAt]
            );

            return res.status(201).json({
                message: 'School invitation created successfully.',
                invitation: {
                    code: invitationCode,
                    intended_school_name: schoolName,
                    expires_at_utc: expiresAt,
                    expires_in_hours: hours
                },
                warning: 'Copy this code now. It cannot be retrieved later.'
            });

        } catch (error) {
            console.error('Invitation creation error:', error);

            return res.status(500).json({
                message: 'Could not create the school invitation.'
            });
        }
    }
);


// ==========================================
// SYSTEM OWNER: VIEW INVITATION HISTORY
// ==========================================
router.get(
    '/owner/invitations',
    requireSystemOwner,
    async (req, res) => {
        try {
            const [invitations] = await db.execute(
                `SELECT
                    id,
                    intended_school_name,
                    expires_at,
                    used_at,
                    created_at,
                    CASE
                        WHEN used_at IS NOT NULL THEN 'used'
                        WHEN expires_at <= UTC_TIMESTAMP() THEN 'expired'
                        ELSE 'unused'
                    END AS status
                 FROM school_registration_invitations
                 ORDER BY created_at DESC
                 LIMIT 200`
            );

            return res.status(200).json({
                invitations
            });

        } catch (error) {
            console.error('Invitation history error:', error);

            return res.status(500).json({
                message: 'Could not retrieve invitation history.'
            });
        }
    }
);





module.exports = router;