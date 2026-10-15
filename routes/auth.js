const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const router = express.Router();

router.post('/register', async (req, res) => {
    console.log("Register route reached");
    const { school_name, admin_name, email, password } = req.body;

    try {
        // 1. Check if email already exists
        const [existingUsers] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ message: "Email already in use." });
        }

        // 2. Insert the new School
        const [schoolResult] = await db.query(
            'INSERT INTO schools (school_name, sub_status) VALUES (?, ?)', 
            [school_name, 'trial']
        );
        const schoolId = schoolResult.insertId; // Get the generated ID

        // 3. Hash the password and insert the Admin User
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await db.query(
            'INSERT INTO users (school_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
            [schoolId, admin_name, email, hashedPassword, 'admin']
        );

        res.status(201).json({ message: "School and Admin registered successfully!" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error during registration." });
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

module.exports = router;