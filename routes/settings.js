const express = require('express');
const db = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ======================================================
// GET SCHOOL SETTINGS
// ======================================================
router.get('/', verifyToken, async (req, res) => {
    try {
        const schoolId = req.user.school_id;

        const [settings] = await db.query(
            `SELECT 
                ss.id,
                ss.school_id,
                ss.school_name,
                ss.motto,
                ss.address,
                ss.phone,
                ss.email,
                ss.current_term,
                ss.academic_year,
                ss.term_status,
                ss.logo_url
             FROM school_settings ss
             WHERE ss.school_id = ?
             LIMIT 1`,
            [schoolId]
        );

        // If this school has no settings yet,
        // return basic information from the schools table.
        if (settings.length === 0) {

            const [school] = await db.query(
                `SELECT id, school_name
                 FROM schools
                 WHERE id = ?
                 LIMIT 1`,
                [schoolId]
            );

            if (school.length === 0) {
                return res.status(404).json({
                    message: 'School not found'
                });
            }

            return res.json({
                school_id: schoolId,
                school_name: school[0].school_name,
                motto: '',
                address: '',
                phone: '',
                email: '',
                current_term: '',
                academic_year: '',
                term_status: 'active',
                logo_url: ''
            });
        }

        res.json(settings[0]);

    } catch (error) {

        console.error('Error fetching school settings:', error);

        res.status(500).json({
            message: 'Error fetching settings'
        });
    }
});








// ======================================================
// GET SCHOOL BRANDING + ACADEMIC STATUS
// ======================================================
router.get('/branding', verifyToken, async (req, res) => {
    try {
        const schoolId = req.user.school_id;

        const [settings] = await db.query(
            `SELECT
                ss.school_name,
                ss.motto,
                ss.logo_url,
                ss.current_term,
                ss.academic_year,
                ss.term_status,

                (
                    SELECT COUNT(DISTINCT ta.teacher_id)
                    FROM teacher_assignments ta
                    INNER JOIN teachers t
                        ON ta.teacher_id = t.id
                    WHERE t.school_id = ss.school_id
                ) AS assigned_teacher_count

             FROM school_settings ss
             WHERE ss.school_id = ?
             LIMIT 1`,
            [schoolId]
        );

        // If school settings do not exist
        if (settings.length === 0) {

            const [school] = await db.query(
                `SELECT school_name
                 FROM schools
                 WHERE id = ?
                 LIMIT 1`,
                [schoolId]
            );

            if (school.length === 0) {
                return res.status(404).json({
                    message: 'School not found'
                });
            }

            const [teacherCount] = await db.query(
                `SELECT COUNT(DISTINCT ta.teacher_id) AS assigned_teacher_count
                 FROM teacher_assignments ta
                 INNER JOIN teachers t
                     ON ta.teacher_id = t.id
                 WHERE t.school_id = ?`,
                [schoolId]
            );

            return res.json({
                school_name: school[0].school_name,
                motto: '',
                logo_url: '',
                assigned_teacher_count:
                    Number(
                        teacherCount[0]?.assigned_teacher_count || 0
                    ),
                current_term: '',
                academic_year: '',
                term_status: 'active'
            });
        }

        res.json({
            school_name: settings[0].school_name || '',
            motto: settings[0].motto || '',
            logo_url: settings[0].logo_url || '',

            assigned_teacher_count:
                Number(settings[0].assigned_teacher_count || 0),

            current_term:
                settings[0].current_term || '',

            academic_year:
                settings[0].academic_year || '',

            term_status:
                settings[0].term_status || 'active'
        });

    } catch (error) {

        console.error(
            'Error fetching school branding:',
            error
        );

        res.status(500).json({
            message: 'Error fetching school branding'
        });
    }
});



// ======================================================
// CREATE / UPDATE SCHOOL SETTINGS
// ======================================================
router.post('/update', verifyToken, async (req, res) => {

    const schoolId = req.user.school_id;

    console.log('===== SETTINGS UPDATE =====');
    console.log('User:', req.user);
    console.log('School ID:', schoolId);
    console.log('Body:', req.body);

    const {
        school_name,
        motto,
        address,
        phone,
        email,
        current_term,
        academic_year,
        term_status
    } = req.body;

    const normalizedTermStatus =
    term_status === 'closed'
        ? 'closed'
        : 'active';

    console.log('ACADEMIC YEAR RECEIVED:', academic_year);
console.log('FULL SETTINGS BODY:', req.body);

    // Academic year is now controlled by the school admin.
    if (!academic_year || !academic_year.trim()) {
        return res.status(400).json({
            message: 'Academic year is required.'
        });
    }

    try {

        const [existing] = await db.query(
            `SELECT id
             FROM school_settings
             WHERE school_id = ?
             LIMIT 1`,
            [schoolId]
        );

        console.log('Existing settings:', existing);

        if (existing.length > 0) {

           const [updateResult] = await db.query(
    `UPDATE school_settings
     SET school_name = ?,
         motto = ?,
         address = ?,
         phone = ?,
         email = ?,
         current_term = ?,
         academic_year = ?,
         term_status = ?
     WHERE school_id = ?`,
    [
        school_name,
        motto,
        address,
        phone,
        email,
        current_term,
        academic_year.trim(),
        term_status || 'active',
        schoolId
    ]
);

console.log('Settings UPDATED');
console.log('UPDATE RESULT:', updateResult);

// Immediately read the saved row back from the SAME database connection
const [verifySettings] = await db.query(
    `SELECT
        school_id,
        current_term,
        academic_year,
        term_status
     FROM school_settings
     WHERE school_id = ?
     LIMIT 1`,
    [schoolId]
);

console.log('DATABASE AFTER UPDATE:', verifySettings);

        } else {

            await db.query(
                `INSERT INTO school_settings
                 (
                    school_id,
                    school_name,
                    motto,
                    address,
                    phone,
                    email,
                    current_term,
                    academic_year,
                    term_status
                 )
                 VALUES (?,?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    schoolId,
                    school_name,
                    motto,
                    address,
                    phone,
                    email,
                    current_term,
                    academic_year.trim(),
                    term_status || 'active'
                ]
            );

            console.log('Settings INSERTED');
        }

        res.json({
    message: 'Settings updated successfully!',
    academic_year: academic_year.trim(),
    current_term: current_term || '',
    term_status: normalizedTermStatus
});

    } catch (error) {

        console.error('SETTINGS DATABASE ERROR:', error);

        res.status(500).json({
            message: 'Error updating settings',
            error: error.message
        });
    }
});


// ======================================================
// MULTER UPLOAD CONFIGURATION
// ======================================================

const uploadDir = path.join(__dirname, '../uploads');

// Make sure uploads folder exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, {
        recursive: true
    });
}

const storage = multer.diskStorage({

    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {

        const schoolId = req.user.school_id;

        const extension = path.extname(file.originalname);

        cb(
            null,
            `${schoolId}_logo${extension}`
        );
    }
});


// ======================================================
// ONLY ALLOW IMAGE FILES
// ======================================================

const fileFilter = (req, file, cb) => {

    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed'), false);
    }
};


const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});


// ======================================================
// UPLOAD SCHOOL LOGO
// ======================================================

router.post(
    '/upload-logo',
    verifyToken,
    upload.single('logo'),
    async (req, res) => {

        try {

            const schoolId = req.user.school_id;

            if (!req.file) {
                return res.status(400).json({
                    message: 'No logo file was uploaded'
                });
            }

            const logoUrl = `/uploads/${req.file.filename}`;

            // Check whether settings already exist
            const [existing] = await db.query(
                `SELECT id
                 FROM school_settings
                 WHERE school_id = ?
                 LIMIT 1`,
                [schoolId]
            );

            if (existing.length > 0) {

                await db.query(
                    `UPDATE school_settings
                     SET logo_url = ?
                     WHERE school_id = ?`,
                    [logoUrl, schoolId]
                );

            } else {

                // Get school name as default
                const [school] = await db.query(
                    `SELECT school_name
                     FROM schools
                     WHERE id = ?
                     LIMIT 1`,
                    [schoolId]
                );

                const schoolName =
                    school.length > 0
                        ? school[0].school_name
                        : '';

                await db.query(
                    `INSERT INTO school_settings
                     (
                        school_id,
                        school_name,
                        logo_url
                     )
                     VALUES (?, ?, ?)`,
                    [
                        schoolId,
                        schoolName,
                        logoUrl
                    ]
                );
            }

            res.json({
                message: 'Logo updated successfully',
                logoUrl
            });

        } catch (error) {

            console.error('Logo upload error:', error);

            res.status(500).json({
                message: 'Failed to update logo'
            });
        }
    }
);


module.exports = router;