const express = require('express');
const db = require('../db');
const multer = require('multer');

const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});


const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');

// Apply authentication to ALL routes
router.use(verifyToken);



// =====================================================
// GET: FETCH STUDENTS FOR THE AUTHENTICATED SCHOOL
// =====================================================

router.get('/', async (req, res) => {
    try {
        const schoolId = req.user.school_id;

        if (!schoolId) {
            return res.status(403).json({
                message: 'Your account is not associated with a school.'
            });
        }

        const [students] = await db.query(
            `
            SELECT *
            FROM students
            WHERE school_id = ?
            ORDER BY full_name ASC
            `,
            [schoolId]
        );

        return res.status(200).json(students);

    } catch (error) {
        console.error('Fetch Students Error:', error);

        return res.status(500).json({
            message: 'Error fetching students.'
        });
    }
});


// =====================================================
// PASSPORT PHOTO UPLOAD — CLOUDINARY
// =====================================================

const storage = multer.memoryStorage();

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
            cb(new Error(
                'Only JPG, JPEG, PNG and WEBP images are allowed.'
            ));
        }
    }
});

// Upload an in-memory image to Cloudinary.
const uploadStudentPhoto = async (file) => {
    if (!file) return null;

    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: 'sukuurecords/student-photos',
                resource_type: 'image'
            },
            (error, result) => {
                if (error) return reject(error);

                if (!result?.secure_url || !result?.public_id) {
                    return reject(
                        new Error('Cloudinary returned an incomplete upload result.')
                    );
                }

                resolve({
                    url: result.secure_url,
                    publicId: result.public_id
                });
            }
        );

        stream.end(file.buffer);
    });
};


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
// 3. POST: ADD STUDENT WITH ADMISSION NUMBER
// =====================================================

router.post('/add', upload.single('passport_photo'), async (req, res) => {
    const {
        first_name,
        middle_name,
        surname,
        parent_email,
        parent_phone,
        current_class,
        gender
    } = req.body;

    const schoolId = req.user.school_id;

    // Validate authenticated school.
    if (!schoolId) {
        return res.status(403).json({
            message: 'Your account is not associated with a school.'
        });
    }

    // Validate student details.
    if (
        typeof first_name !== 'string' ||
        !first_name.trim() ||
        typeof surname !== 'string' ||
        !surname.trim() ||
        typeof current_class !== 'string' ||
        !current_class.trim()
    ) {
        return res.status(400).json({
            message: 'First name, surname, and class are required.'
        });
    }

    if (
        (middle_name != null && typeof middle_name !== 'string') ||
        (parent_email != null && typeof parent_email !== 'string') ||
        (parent_phone != null && typeof parent_phone !== 'string')
    ) {
        return res.status(400).json({
            message: 'Invalid student information provided.'
        });
    }

    const firstName = first_name.trim();
    const middleName = middle_name?.trim() || null;
    const surnameName = surname.trim();
    const className = current_class.trim();

    const fullName = [
        firstName,
        middleName,
        surnameName
    ].filter(Boolean).join(' ');

   let connection;
let transactionStarted = false;
let uploadedPhoto = null;

try {
        connection = await db.getConnection();

        await connection.beginTransaction();
        transactionStarted = true;

        // Get and lock the authenticated school's record.
        const [schools] = await connection.query(
            `SELECT admission_code
             FROM schools
             WHERE id = ?
             FOR UPDATE`,
            [schoolId]
        );

        if (schools.length === 0) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(403).json({
                message: 'The school associated with your account was not found.'
            });
        }

        const schoolCode = schools[0].admission_code;

        if (
            typeof schoolCode !== 'string' &&
            typeof schoolCode !== 'number'
        ) {
            throw new Error('School admission code is missing.');
        }

        const normalizedSchoolCode = String(schoolCode).trim();

        if (!/^\d{4}$/.test(normalizedSchoolCode)) {
            throw new Error('School admission code must contain four digits.');
        }

        // The backend determines the admission year.
       const admissionYear = Number(
    new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Accra',
        year: 'numeric'
    }).format(new Date())
);


        // Create this school's counter for the year if necessary.
        await connection.query(
            `INSERT INTO student_admission_counters
                (school_id, admission_year, last_sequence)
             VALUES (?, ?, 0)
             ON DUPLICATE KEY UPDATE
                last_sequence = last_sequence`,
            [schoolId, admissionYear]
        );

        // Lock the counter while assigning the next sequence.
        const [counterRows] = await connection.query(
            `SELECT last_sequence
             FROM student_admission_counters
             WHERE school_id = ?
               AND admission_year = ?
             FOR UPDATE`,
            [schoolId, admissionYear]
        );

        if (counterRows.length !== 1) {
            throw new Error('Unable to retrieve the admission counter.');
        }

        const nextSequence =
            Number(counterRows[0].last_sequence) + 1;

        if (
            !Number.isSafeInteger(nextSequence) ||
            nextSequence < 1 ||
            nextSequence > 9999
        ) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(409).json({
                message: 'The admission-number limit for this school and year has been reached.'
            });
        }

        const yearCode = String(admissionYear).slice(-2);
        const sequenceCode = String(nextSequence).padStart(4, '0');

        const admissionNumber =
            `AJ${yearCode}-${normalizedSchoolCode}-${sequenceCode}`;

       // Upload the passport photo to Cloudinary, if provided.
uploadedPhoto = await uploadStudentPhoto(req.file);

const passportPhotoUrl = uploadedPhoto
    ? uploadedPhoto.url
    : null;



        // Reserve the sequence in the same transaction as the student.
        await connection.query(
            `UPDATE student_admission_counters
             SET last_sequence = ?
             WHERE school_id = ?
               AND admission_year = ?`,
            [nextSequence, schoolId, admissionYear]
        );

        const [result] = await connection.query(
            `INSERT INTO students (
                school_id,
                full_name,
                first_name,
                middle_name,
                surname,
                admission_number,
                parent_email,
                parent_phone,
                current_class,
                gender,
                passport_photo_url
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                schoolId,
                fullName,
                firstName,
                middleName,
                surnameName,
                admissionNumber,
                parent_email?.trim() || null,
                parent_phone?.trim() || null,
                className,
                gender || 'Other',
                passportPhotoUrl
            ]
        );

        await connection.commit();
        transactionStarted = false;

        return res.status(201).json({
            message: 'Student added successfully.',
            studentId: result.insertId,
            full_name: fullName,
            admission_number: admissionNumber,
            passport_photo_url: passportPhotoUrl
        });

    } catch (error) {
    if (connection && transactionStarted) {
        try {
            await connection.rollback();
            transactionStarted = false;
        } catch (rollbackError) {
            console.error(
                'Student registration rollback error:',
                rollbackError
            );
        }
    }

    // Remove the newly uploaded Cloudinary image if registration fails.
    if (uploadedPhoto?.publicId) {
        try {
            await cloudinary.uploader.destroy(
                uploadedPhoto.publicId,
                { resource_type: 'image' }
            );
        } catch (cleanupError) {
            console.error(
                'Cloudinary student-photo cleanup error:',
                cleanupError
            );
        }
    }

    console.error('Add Student Error:', error);

    return res.status(500).json({
        message: 'Error adding student.'
    });
} finally {
    if (connection) {
        connection.release();
    }
}
});

// =====================================================
// 5. PUT: EDIT STUDENT
// =====================================================

router.put('/:id', upload.single('passport_photo'), async (req, res) => {
    const studentId = req.params.id;
    const schoolId = req.user.school_id;

    const {
        first_name,
        middle_name,
        surname,
        full_name,
        parent_email,
        parent_phone,
        current_class,
        gender
    } = req.body;
let uploadedPhoto = null;
let databaseUpdateSucceeded = false;


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
            // Remove the newly uploaded Cloudinary image if the student

            return res.status(404).json({
                message: 'Student not found'
            });
        }

        const existingStudent = students[0];

        // ---------------------------------------------
        // Construct the student's full name
        // ---------------------------------------------

        let updatedFullName;

       const hasSeparateNameFields =
    first_name !== undefined ||
    middle_name !== undefined ||
    surname !== undefined;

if (hasSeparateNameFields) {
    if (
        (first_name !== undefined && typeof first_name !== 'string') ||
        (middle_name !== undefined && typeof middle_name !== 'string') ||
        (surname !== undefined && typeof surname !== 'string')
    ) {
        return res.status(400).json({
            message: 'Invalid student name fields.'
        });
    }

    const cleanFirstName = (first_name || '').trim();
    const cleanMiddleName = (middle_name || '').trim();
    const cleanSurname = (surname || '').trim();

            if (!cleanFirstName || !cleanSurname) {
                return res.status(400).json({
                    message: 'First name and surname are required.'
                });
            }

            if (
                cleanFirstName.length > 100 ||
                cleanMiddleName.length > 150 ||
                cleanSurname.length > 100
            ) {

                return res.status(400).json({
                    message: 'One or more name fields exceed the allowed length.'
                });
            }

            updatedFullName = [
                cleanFirstName,
                cleanMiddleName,
                cleanSurname
            ]
                .filter(Boolean)
                .join(' ');

        } else if (full_name !== undefined) {
            // Backward compatibility for older clients.
           if (typeof full_name !== 'string') {
    return res.status(400).json({
        message: 'Invalid student name.'
    });
}

updatedFullName = full_name.trim();

            if (!updatedFullName) {
                return res.status(400).json({
                    message: 'Student name is required.'
                });
            }

        } else {
            // If no name fields were submitted, preserve
            // the existing full name.
            updatedFullName = existingStudent.full_name;
        }

        // ---------------------------------------------
        // Keep old photo if no new photo is uploaded
        // ---------------------------------------------

       // Preserve the existing photo unless a replacement is uploaded.
// Preserve the existing photo unless a replacement is uploaded.
let passportPhotoUrl = existingStudent.passport_photo_url;

if (req.file) {
    uploadedPhoto = await uploadStudentPhoto(req.file);
    passportPhotoUrl = uploadedPhoto.url;
}
        // ---------------------------------------------
        // Update student
        // ---------------------------------------------

        await db.query(
            `
            UPDATE students
            SET
                full_name = ?,
                first_name = ?,
                middle_name = ?,
                surname = ?,
                parent_email = ?,
                parent_phone = ?,
                current_class = ?,
                gender = ?,
                passport_photo_url = ?
            WHERE id = ?
              AND school_id = ?
            `,
            [
                updatedFullName,

              hasSeparateNameFields
    ? first_name.trim()
    : (full_name !== undefined
        ? null
        : existingStudent.first_name),


               hasSeparateNameFields
    ? ((middle_name || '').trim() || null)
    : (full_name !== undefined
        ? null
        : existingStudent.middle_name),

               hasSeparateNameFields
    ? surname.trim()
    : (full_name !== undefined
        ? null
        : existingStudent.surname),

                parent_email !== undefined
                    ? (parent_email.trim() || null)
                    : existingStudent.parent_email,

                parent_phone !== undefined
                    ? (parent_phone.trim() || null)
                    : existingStudent.parent_phone,

                current_class !== undefined
                    ? current_class
                    : existingStudent.current_class,

                gender !== undefined
                    ? (gender || 'Other')
                    : existingStudent.gender,

                passportPhotoUrl,
                studentId,
                schoolId
            ]
        );

        databaseUpdateSucceeded = true;


        res.json({
            message: 'Student updated successfully',
            studentId,
            full_name: updatedFullName,
            admission_number: existingStudent.admission_number,
            passport_photo_url: passportPhotoUrl
        });




    } catch (error) {
    console.error('Update Student Error:', error);

    // Clean up the new Cloudinary image if the update failed.
   if (uploadedPhoto?.publicId && !databaseUpdateSucceeded) {
        try {
            await cloudinary.uploader.destroy(
                uploadedPhoto.publicId,
                { resource_type: 'image' }
            );
        } catch (cleanupError) {
            console.error(
                'New Cloudinary photo cleanup error:',
                cleanupError
            );
        }
    }

    return res.status(500).json({
        message: 'Error updating student'
    });
}
});





module.exports = router;