const express = require('express');
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');

// Apply authentication to ALL routes
router.use(verifyToken);


// =====================================================
// PASSPORT PHOTO UPLOAD CONFIGURATION
// =====================================================

const uploadDir = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const uniqueName =
            `student-${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 5 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {

        const allowedTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp'
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(
                new Error(
                    'Only JPG, JPEG, PNG and WEBP images are allowed.'
                )
            );
        }
    }
});


// =====================================================
// 1. GET: SUMMARY STATISTICS
// =====================================================

router.get('/stats/summary', async (req, res) => {

    try {

        const schoolId = req.user.school_id;

        const [total] = await db.query(
            "SELECT COUNT(*) as count FROM students WHERE school_id = ?",
            [schoolId]
        );

        const [classDist] = await db.query(
            "SELECT current_class, COUNT(*) as count FROM students WHERE school_id = ? GROUP BY current_class",
            [schoolId]
        );

        const [genderDist] = await db.query(
            "SELECT gender, COUNT(*) as count FROM students WHERE school_id = ? GROUP BY gender",
            [schoolId]
        );

        res.json({
            totalStudents: total[0].count,
            classDistribution: classDist,
            genderDistribution: genderDist
        });

    } catch (error) {

        console.error("Stats Error:", error);

        res.status(500).json({
            message: "Error fetching stats"
        });
    }
});


// =====================================================
// 2. GET: UNIQUE CLASSES
// =====================================================

router.get('/classes', async (req, res) => {

    try {

        const schoolId = req.user.school_id;

        const [results] = await db.query(
            "SELECT DISTINCT current_class FROM students WHERE school_id = ?",
            [schoolId]
        );

        res.json(
            results.map(row => row.current_class)
        );

    } catch (error) {

        console.error("Classes Error:", error);

        res.status(500).json({
            message: "Error fetching classes"
        });
    }
});


// =====================================================
// 3. POST: ADD STUDENT
// =====================================================

router.post('/add', upload.single('passport_photo'), async (req, res) => {

    const {
        full_name,
        parent_email,
        parent_phone,
        current_class,
        gender
    } = req.body;

    const schoolId = req.user.school_id;

    if (!full_name || !current_class) {
        return res.status(400).json({
            message: "Full name and class are required"
        });
    }

    try {

        const passportPhotoUrl = req.file
            ? `/uploads/${req.file.filename}`
            : null;

        const [result] = await db.query(
            `
            INSERT INTO students
            (
                school_id,
                full_name,
                parent_email,
                parent_phone,
                current_class,
                gender,
                passport_photo_url
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [
                schoolId,
                full_name,
                parent_email || null,
                parent_phone || null,
                current_class,
                gender || 'Other',
                passportPhotoUrl
            ]
        );

        res.status(201).json({
            message: "Student added successfully",
            studentId: result.insertId,
            passport_photo_url: passportPhotoUrl
        });

    } catch (error) {

        console.error("Add Student Error:", error);

        res.status(500).json({
            message: "Error adding student"
        });
    }
});


// =====================================================
// 4. GET: ALL STUDENTS / STUDENTS BY CLASS
// =====================================================

router.get('/', async (req, res) => {

    const schoolId = req.user.school_id;
    const className = req.query.current_class;

    try {

        let sql =
            "SELECT * FROM students WHERE school_id = ?";

        let params = [schoolId];

        if (className) {

            sql +=
                " AND current_class = ?";

            params.push(className);
        }

        sql += " ORDER BY full_name ASC";

        const [results] =
            await db.query(sql, params);

        res.json(results);

    } catch (error) {

        console.error(
            "Fetch Students Error:",
            error
        );

        res.status(500).json({
            message: "Server error"
        });
    }
});


// =====================================================
// 5. PUT: EDIT STUDENT
// =====================================================

router.put('/:id', upload.single('passport_photo'), async (req, res) => {

    const studentId = req.params.id;
    const schoolId = req.user.school_id;

    const {
        full_name,
        parent_email,
        parent_phone,
        current_class,
        gender
    } = req.body;

    try {

        // ---------------------------------------------
        // Confirm student belongs to this school
        // ---------------------------------------------

        const [students] = await db.query(
            `
            SELECT *
            FROM students
            WHERE id = ?
              AND school_id = ?
            `,
            [studentId, schoolId]
        );

        if (students.length === 0) {

            return res.status(404).json({
                message: "Student not found"
            });
        }

        const existingStudent = students[0];

        // ---------------------------------------------
        // Keep old photo if no new photo is uploaded
        // ---------------------------------------------

        let passportPhotoUrl =
            existingStudent.passport_photo_url;

        if (req.file) {

            passportPhotoUrl =
                `/uploads/${req.file.filename}`;
        }

        // ---------------------------------------------
        // Update student
        // ---------------------------------------------

        await db.query(
            `
            UPDATE students
            SET
                full_name = ?,
                parent_email = ?,
                parent_phone = ?,
                current_class = ?,
                gender = ?,
                passport_photo_url = ?
            WHERE id = ?
              AND school_id = ?
            `,
            [
                full_name,
                parent_email || null,
                parent_phone || null,
                current_class,
                gender || 'Other',
                passportPhotoUrl,
                studentId,
                schoolId
            ]
        );

        res.json({
            message: "Student updated successfully",
            passport_photo_url: passportPhotoUrl
        });

    } catch (error) {

        console.error(
            "Update Student Error:",
            error
        );

        res.status(500).json({
            message: "Error updating student"
        });
    }
});


module.exports = router;