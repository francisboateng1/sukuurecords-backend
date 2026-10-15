const express = require('express');
const db = require('../db'); 
const router = express.Router();

// 1. The missing POST route to save marks
router.post('/record', async (req, res) => {
    const { student_id, teacher_id, subject, class_score, exam_score, term, academic_year } = req.body;

    // Calculate the total (Class 30% + Exam 70% logic happens here)
    const total_score = parseFloat(class_score || 0) + parseFloat(exam_score || 0);

    try {
        const sql = `INSERT INTO assessments 
            (student_id, teacher_id, subject, class_score, exam_score, total_score, term, academic_year) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        await db.query(sql, [
            student_id, 
            teacher_id || 1, // Defaulting to 1 if not provided
            subject, 
            class_score, 
            exam_score, 
            total_score, 
            term || 'Term 1', 
            academic_year || '2025/2026'
        ]);
        
        res.status(200).json({ message: "Marks recorded successfully", total: total_score });
    } catch (error) {
        console.error("Database Error:", error);
        res.status(500).json({ message: "Error recording marks" });
    }
});

// 2. Your existing Leaderboard route
router.get('/leaderboard/:className', async (req, res) => {
    const { className } = req.params;
    const sql = `
        SELECT 
            s.full_name, 
            s.current_class,
            COALESCE(SUM(a.total_score), 0) as grand_total, 
            RANK() OVER (ORDER BY COALESCE(SUM(a.total_score), 0) DESC) as position
        FROM students s
        LEFT JOIN assessments a ON s.id = a.student_id
        WHERE s.current_class = ?
        GROUP BY s.id
        ORDER BY grand_total DESC`;
    try {
        const [results] = await db.query(sql, [className]);
        res.json(results);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error calculating rankings" });
    }
});

// 3. Your existing test route
router.get('/test', (req, res) => {
    res.json({ message: "Assessment route is working!" });
});



// POST: Save multiple marks at once
router.post('/bulk-record', async (req, res) => {
    const { marks, subject, term, academic_year, teacher_id } = req.body;

    // 1. Safety Check: If no marks are sent, don't run the query
    if (!marks || marks.length === 0) {
        return res.status(400).json({ message: "No marks provided to save." });
    }

    try {
        const sql = `INSERT INTO assessments 
            (student_id, teacher_id, subject, class_score, exam_score, total_score, term, academic_year) 
            VALUES ?`;

        // 2. Format data: This creates an array of arrays
        const values = marks.map(m => [
            m.student_id,
            teacher_id || 1,
            subject,
            m.class_score || 0,
            m.exam_score || 0,
            (parseFloat(m.class_score || 0) + parseFloat(m.exam_score || 0)),
            term || 'Term 1',
            academic_year || '2025/2026'
        ]);

        // 3. CRITICAL: Wrap 'values' in another array [values] 
        // This is required by the mysql2 library for bulk inserts
        await db.query(sql, [values]); 
        
        res.status(200).json({ message: `Successfully recorded marks for ${marks.length} students!` });
    } catch (error) {
        console.error("Bulk Insert Error:", error);
        res.status(500).json({ message: "Error saving bulk marks" });
    }
});





// GET: Comprehensive data for a student's terminal report
// =====================================================
// COMPREHENSIVE STUDENT REPORT
// Supports:
// - Term 1
// - Term 2
// - Term 3
// - Full Academic Year
// - Subject ranking
// - Overall class ranking
// - Attendance
// - School information
// =====================================================

router.get('/student-report/:studentId', async (req, res) => {
    const { studentId } = req.params;
    const { term, academic_year } = req.query;

    try {

        // -------------------------------------------------
        // VALIDATION
        // -------------------------------------------------

        if (!academic_year) {
            return res.status(400).json({
                message: 'Academic year is required.'
            });
        }


        // -------------------------------------------------
        // GET STUDENT
        // -------------------------------------------------

        const [students] = await db.query(
            `
            SELECT
                id,
                school_id,
                full_name,
                parent_email,
                parent_phone,
                current_class,
                gender,
                passport_photo_url
            FROM students
            WHERE id = ?
            LIMIT 1
            `,
            [studentId]
        );

        if (students.length === 0) {
            return res.status(404).json({
                message: 'Student not found.'
            });
        }

        const student = students[0];

        const schoolId = student.school_id;
        const className = student.current_class;


        // -------------------------------------------------
        // GET SCHOOL INFORMATION
        // -------------------------------------------------

        const [schoolSettings] = await db.query(
            `
            SELECT
                school_name,
                motto,
                address,
                phone,
                email,
                logo_url
            FROM school_settings
            WHERE school_id = ?
            LIMIT 1
            `,
            [schoolId]
        );

        const [schoolRows] = await db.query(
            `
            SELECT school_name
            FROM schools
            WHERE id = ?
            LIMIT 1
            `,
            [schoolId]
        );

        const school = {
            school_name:
                schoolSettings.length > 0
                    ? schoolSettings[0].school_name
                    : schoolRows.length > 0
                    ? schoolRows[0].school_name
                    : '',

            motto:
                schoolSettings.length > 0
                    ? schoolSettings[0].motto
                    : '',

            address:
                schoolSettings.length > 0
                    ? schoolSettings[0].address
                    : '',

            phone:
                schoolSettings.length > 0
                    ? schoolSettings[0].phone
                    : '',

            email:
                schoolSettings.length > 0
                    ? schoolSettings[0].email
                    : '',

            logo_url:
                schoolSettings.length > 0
                    ? schoolSettings[0].logo_url
                    : ''
        };


        // =================================================
        // TERM REPORT
        // =================================================

        if (term) {

            // -------------------------------------------------
            // GET STUDENT MARKS
            // -------------------------------------------------

            const [marks] = await db.query(
                `
                SELECT
                    a.subject,
                    a.class_score,
                    a.exam_score,
                    a.total_score
                FROM assessments a
                INNER JOIN students s
                    ON s.id = a.student_id
                WHERE a.student_id = ?
                AND s.school_id = ?
                AND a.term = ?
                AND a.academic_year = ?
                ORDER BY a.subject ASC
                `,
                [
                    studentId,
                    schoolId,
                    term,
                    academic_year
                ]
            );


            // -------------------------------------------------
            // SUBJECT RANKINGS
            // Compare student with classmates
            // -------------------------------------------------

            const [subjectRankings] = await db.query(
                `
                SELECT
                    a.subject,
                    a.student_id,
                    a.total_score,
                    RANK() OVER (
                        PARTITION BY a.subject
                        ORDER BY a.total_score DESC
                    ) AS subject_rank
                FROM assessments a
                INNER JOIN students s
                    ON s.id = a.student_id
                WHERE s.school_id = ?
                AND s.current_class = ?
                AND a.term = ?
                AND a.academic_year = ?
                `,
                [
                    schoolId,
                    className,
                    term,
                    academic_year
                ]
            );


            // Attach subject ranking to student's marks
            const formattedMarks = marks.map(mark => {

                const ranking = subjectRankings.find(
                    r =>
                        r.student_id == studentId &&
                        r.subject === mark.subject
                );

                return {
                    subject: mark.subject,
                    class_score: Number(mark.class_score || 0),
                    exam_score: Number(mark.exam_score || 0),
                    total_score: Number(mark.total_score || 0),
                    subject_rank: ranking
                        ? Number(ranking.subject_rank)
                        : null
                };
            });


            // -------------------------------------------------
            // OVERALL CLASS RANKING
            // Sum all subject totals for every student
            // in the same class, term and academic year.
            // -------------------------------------------------

            // -------------------------------------------------
// OVERALL CLASS RANKING
// Rank students who have marks.
// Class size is ALL students enrolled in the class.
// -------------------------------------------------

const [classRanking] = await db.query(
    `
    SELECT
        student_id,
        grand_total,
        average_score,
        RANK() OVER (
            ORDER BY grand_total DESC
        ) AS class_position
    FROM (
        SELECT
            a.student_id,
            SUM(a.total_score) AS grand_total,
            AVG(a.total_score) AS average_score
        FROM assessments a
        INNER JOIN students s
            ON s.id = a.student_id
        WHERE s.school_id = ?
        AND s.current_class = ?
        AND a.term = ?
        AND a.academic_year = ?
        GROUP BY a.student_id
    ) ranked_students
    ORDER BY grand_total DESC
    `,
    [
        schoolId,
        className,
        term,
        academic_year
    ]
);


const studentRanking = classRanking.find(
    r => r.student_id == studentId
);


// IMPORTANT:
// Class size must include EVERY student in the class,
// not only students who have assessment records.

const [[classSizeRow]] = await db.query(
    `
    SELECT COUNT(*) AS class_size
    FROM students
    WHERE school_id = ?
    AND current_class = ?
    `,
    [
        schoolId,
        className
    ]
);

const classSize = Number(
    classSizeRow.class_size || 0
);


            // -------------------------------------------------
            // ATTENDANCE
            // -------------------------------------------------

            const [attendanceRows] = await db.query(
                `
                SELECT
                    COUNT(*) AS total_days,

                    SUM(
                        CASE
                            WHEN status = 'Present'
                            THEN 1
                            ELSE 0
                        END
                    ) AS present_days,

                    SUM(
                        CASE
                            WHEN status = 'Absent'
                            THEN 1
                            ELSE 0
                        END
                    ) AS absent_days,

                    SUM(
                        CASE
                            WHEN status = 'Late'
                            THEN 1
                            ELSE 0
                        END
                    ) AS late_days

                FROM attendance
                WHERE student_id = ?
                AND term = ?
                AND academic_year = ?
                `,
                [
                    studentId,
                    term,
                    academic_year
                ]
            );


            const attendance = attendanceRows[0] || {};

            const totalDays =
                Number(attendance.total_days || 0);

            const presentDays =
                Number(attendance.present_days || 0);

            const absentDays =
                Number(attendance.absent_days || 0);

            const lateDays =
                Number(attendance.late_days || 0);

            const attendedDays =
                presentDays + lateDays;

            const attendancePercentage =
                totalDays > 0
                    ? Number(
                        (
                            attendedDays /
                            totalDays
                        ) * 100
                    ).toFixed(2)
                    : 0;


            // -------------------------------------------------
            // RESPONSE
            // -------------------------------------------------

            return res.json({

                profile: {
                    id: student.id,
                    full_name: student.full_name,
                    current_class: student.current_class,
                    gender: student.gender,
                    passport_photo_url:
                        student.passport_photo_url
                },

                school,

                report: {
                    type: 'term',
                    term,
                    academic_year,

                    class_position:
                        studentRanking
                            ? Number(
                                studentRanking.class_position
                            )
                            : null,

                    class_size: classSize,

                    overall_total:
                        studentRanking
                            ? Number(
                                studentRanking.grand_total
                            )
                            : 0,

                    overall_average:
                        studentRanking
                            ? Number(
                                studentRanking.average_score
                            ).toFixed(2)
                            : 0
                },

                marks: formattedMarks,

                attendance: {
                    total_days: totalDays,
                    present_days: presentDays,
                    absent_days: absentDays,
                    late_days: lateDays,
                    attended_days: attendedDays,
                    percentage: attendancePercentage
                }
            });
        }


        // =================================================
        // FULL ACADEMIC YEAR REPORT
        // =================================================

        const availableTerms = [
            'Term 1',
            'Term 2',
            'Term 3'
        ];

        const terms = {};

        for (const currentTerm of availableTerms) {

            // -------------------------------------------------
            // Check whether this student has marks
            // for this term
            // -------------------------------------------------

            const [termMarks] = await db.query(
                `
                SELECT
                    a.subject,
                    a.class_score,
                    a.exam_score,
                    a.total_score
                FROM assessments a
                INNER JOIN students s
                    ON s.id = a.student_id
                WHERE a.student_id = ?
                AND s.school_id = ?
                AND a.term = ?
                AND a.academic_year = ?
                ORDER BY a.subject ASC
                `,
                [
                    studentId,
                    schoolId,
                    currentTerm,
                    academic_year
                ]
            );

            // Skip terms where this student has no records
            if (termMarks.length === 0) {
                continue;
            }


            // -------------------------------------------------
            // Subject rankings
            // -------------------------------------------------

            const [rankings] = await db.query(
                `
                SELECT
                    a.subject,
                    a.student_id,
                    RANK() OVER (
                        PARTITION BY a.subject
                        ORDER BY a.total_score DESC
                    ) AS subject_rank
                FROM assessments a
                INNER JOIN students s
                    ON s.id = a.student_id
                WHERE s.school_id = ?
                AND s.current_class = ?
                AND a.term = ?
                AND a.academic_year = ?
                `,
                [
                    schoolId,
                    className,
                    currentTerm,
                    academic_year
                ]
            );


            const formattedTermMarks =
                termMarks.map(mark => {

                    const ranking = rankings.find(
                        r =>
                            r.student_id == studentId &&
                            r.subject === mark.subject
                    );

                    return {
                        subject: mark.subject,
                        class_score:
                            Number(
                                mark.class_score || 0
                            ),
                        exam_score:
                            Number(
                                mark.exam_score || 0
                            ),
                        total_score:
                            Number(
                                mark.total_score || 0
                            ),
                        subject_rank:
                            ranking
                                ? Number(
                                    ranking.subject_rank
                                )
                                : null
                    };
                });


            // -------------------------------------------------
            // Term class ranking
            // -------------------------------------------------

            const [termRanking] = await db.query(
                `
                SELECT
                    student_id,
                    grand_total,
                    average_score,
                    RANK() OVER (
                        ORDER BY grand_total DESC
                    ) AS class_position
                FROM (
                    SELECT
                        a.student_id,
                        SUM(a.total_score) AS grand_total,
                        AVG(a.total_score) AS average_score
                    FROM assessments a
                    INNER JOIN students s
                        ON s.id = a.student_id
                    WHERE s.school_id = ?
                    AND s.current_class = ?
                    AND a.term = ?
                    AND a.academic_year = ?
                    GROUP BY a.student_id
                ) ranked_students
                ORDER BY grand_total DESC
                `,
                [
                    schoolId,
                    className,
                    currentTerm,
                    academic_year
                ]
            );


            const termStudentRanking =
                termRanking.find(
                    r => r.student_id == studentId
                );


            // -------------------------------------------------
            // Term attendance
            // -------------------------------------------------

            const [termAttendance] = await db.query(
                `
                SELECT
                    COUNT(*) AS total_days,

                    SUM(
                        CASE
                            WHEN status = 'Present'
                            THEN 1
                            ELSE 0
                        END
                    ) AS present_days,

                    SUM(
                        CASE
                            WHEN status = 'Absent'
                            THEN 1
                            ELSE 0
                        END
                    ) AS absent_days,

                    SUM(
                        CASE
                            WHEN status = 'Late'
                            THEN 1
                            ELSE 0
                        END
                    ) AS late_days

                FROM attendance
                WHERE student_id = ?
                AND term = ?
                AND academic_year = ?
                `,
                [
                    studentId,
                    currentTerm,
                    academic_year
                ]
            );


            const attendance =
                termAttendance[0] || {};

            const totalDays =
                Number(attendance.total_days || 0);

            const presentDays =
                Number(attendance.present_days || 0);

            const absentDays =
                Number(attendance.absent_days || 0);

            const lateDays =
                Number(attendance.late_days || 0);

            const attendedDays =
                presentDays + lateDays;

            const attendancePercentage =
                totalDays > 0
                    ? Number(
                        (
                            attendedDays /
                            totalDays
                        ) * 100
                    ).toFixed(2)
                    : 0;


           // Get total number of students enrolled in this class
const [[termClassSizeRow]] = await db.query(
    `
    SELECT COUNT(*) AS class_size
    FROM students
    WHERE school_id = ?
    AND current_class = ?
    `,
    [
        schoolId,
        className
    ]
);

const termClassSize = Number(
    termClassSizeRow.class_size || 0
);


terms[currentTerm] = {

    marks: formattedTermMarks,

    class_position:
        termStudentRanking
            ? Number(
                termStudentRanking.class_position
            )
            : null,

    class_size:
        termClassSize,

                overall_total:
                    termStudentRanking
                        ? Number(
                            termStudentRanking.grand_total
                        )
                        : 0,

                overall_average:
                    termStudentRanking
                        ? Number(
                            termStudentRanking.average_score
                        ).toFixed(2)
                        : 0,

                attendance: {
                    total_days: totalDays,
                    present_days: presentDays,
                    absent_days: absentDays,
                    late_days: lateDays,
                    attended_days: attendedDays,
                    percentage: attendancePercentage
                }
            };
        }


        // -------------------------------------------------
        // FULL-YEAR SUMMARY
        // -------------------------------------------------

        const termNames = Object.keys(terms);

        let yearlyTotal = 0;
        let yearlyAverage = 0;

        if (termNames.length > 0) {

            yearlyTotal = termNames.reduce(
                (sum, t) =>
                    sum + Number(
                        terms[t].overall_total || 0
                    ),
                0
            );

            yearlyAverage =
                termNames.reduce(
                    (sum, t) =>
                        sum + Number(
                            terms[t].overall_average || 0
                        ),
                    0
                ) / termNames.length;
        }


        // -------------------------------------------------
        // FULL-YEAR ATTENDANCE
        // -------------------------------------------------

        const [yearAttendance] = await db.query(
            `
            SELECT
                COUNT(*) AS total_days,

                SUM(
                    CASE
                        WHEN status = 'Present'
                        THEN 1
                        ELSE 0
                    END
                ) AS present_days,

                SUM(
                    CASE
                        WHEN status = 'Absent'
                        THEN 1
                        ELSE 0
                    END
                ) AS absent_days,

                SUM(
                    CASE
                        WHEN status = 'Late'
                        THEN 1
                        ELSE 0
                    END
                ) AS late_days

            FROM attendance
            WHERE student_id = ?
            AND academic_year = ?
            `,
            [
                studentId,
                academic_year
            ]
        );


        const yearlyAttendance =
            yearAttendance[0] || {};

        const totalYearDays =
            Number(
                yearlyAttendance.total_days || 0
            );

        const presentYearDays =
            Number(
                yearlyAttendance.present_days || 0
            );

        const absentYearDays =
            Number(
                yearlyAttendance.absent_days || 0
            );

        const lateYearDays =
            Number(
                yearlyAttendance.late_days || 0
            );

        const attendedYearDays =
            presentYearDays + lateYearDays;

        const yearlyAttendancePercentage =
            totalYearDays > 0
                ? Number(
                    (
                        attendedYearDays /
                        totalYearDays
                    ) * 100
                ).toFixed(2)
                : 0;


        // -------------------------------------------------
        // RESPONSE
        // -------------------------------------------------

        res.json({

            profile: {
                id: student.id,
                full_name: student.full_name,
                current_class: student.current_class,
                gender: student.gender,
                passport_photo_url:
                    student.passport_photo_url
            },

            school,

            report: {
                type: 'academic_year',
                academic_year,

                available_terms: termNames,

                term_count: termNames.length,

                yearly_total: yearlyTotal,

                yearly_average:
                    Number(yearlyAverage).toFixed(2)
            },

            terms,

            attendance: {
                total_days: totalYearDays,
                present_days: presentYearDays,
                absent_days: absentYearDays,
                late_days: lateYearDays,
                attended_days: attendedYearDays,
                percentage:
                    yearlyAttendancePercentage
            }
        });

    } catch (error) {

        console.error(
            'Error generating student report:',
            error
        );

        res.status(500).json({
            message: 'Error generating report data'
        });
    }
});














// =====================================================
// TEACHER AUTHENTICATION
// =====================================================

const jwt = require('jsonwebtoken');

async function authenticateTeacher(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: 'Authentication required.'
            });
        }

        const token = authHeader.split(' ')[1];

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET || 'your_secret_key'
        );

        if (!decoded.id || !decoded.school_id) {
            return res.status(401).json({
                message: 'Invalid authentication token.'
            });
        }

        // IMPORTANT:
        // decoded.id is users.id.
        req.user = decoded;

        next();

    } catch (error) {
        console.error('Teacher authentication error:', error);

        return res.status(401).json({
            message: 'Invalid or expired token.'
        });
    }
}


// =====================================================
// GET CURRENT TEACHER PROFILE + ASSIGNMENTS
// =====================================================
router.get(
    '/teacher/profile',
    authenticateTeacher,
    async (req, res) => {

        try {

            const userId = req.user.id;
            const schoolId = req.user.school_id;

            // ============================================
            // GET LOGGED-IN USER
            // ============================================

            const [users] = await db.query(
                `
                SELECT
                    id,
                    email,
                    school_id,
                    role
                FROM users
                WHERE id = ?
                AND school_id = ?
                AND role = 'teacher'
                LIMIT 1
                `,
                [userId, schoolId]
            );

            if (users.length === 0) {
                return res.status(404).json({
                    message: 'Teacher account not found.'
                });
            }

            const user = users[0];

            // ============================================
            // FIND TEACHER PROFILE BY EMAIL
            // ============================================

            const [teachers] = await db.query(
                `
                SELECT
                    id,
                    full_name,
                    email,
                    school_id
                FROM teachers
                WHERE email = ?
                AND school_id = ?
                LIMIT 1
                `,
                [
                    user.email,
                    schoolId
                ]
            );

            if (teachers.length === 0) {
                return res.status(404).json({
                    message: 'Teacher profile not found.'
                });
            }

            const teacher = teachers[0];

            // ============================================
            // GET ALL ASSIGNMENTS
            // ============================================

            const [assignments] = await db.query(
                `
                SELECT
                    ta.id AS assignment_id,

                    c.id AS class_id,
                    c.class_name,

                    s.id AS subject_id,
                    s.subject_name

                FROM teacher_assignments ta

                INNER JOIN school_classes c
                    ON ta.class_id = c.id
                    AND c.school_id = ?

                INNER JOIN school_subjects s
                    ON ta.subject_id = s.id
                    AND s.school_id = ?

                WHERE ta.teacher_id = ?

                ORDER BY
                    c.class_name ASC,
                    s.subject_name ASC
                `,
                [
                    schoolId,
                    schoolId,
                    teacher.id
                ]
            );

            console.log('====================================');
            console.log('TEACHER PROFILE DEBUG');
            console.log('userId:', userId);
            console.log('user email:', user.email);
            console.log('schoolId:', schoolId);
            console.log('teacherId:', teacher.id);
            console.log('assignments:', assignments);
            console.log('====================================');

            return res.json({
                teacher,
                assignments
            });

        } catch (error) {

            console.error(
                'Teacher profile error:',
                error
            );

            return res.status(500).json({
                message: 'Failed to load teacher profile.'
            });
        }
    }
);







// =====================================================
// GET STUDENTS FOR AN ASSIGNED CLASS
// =====================================================

router.get(
    '/teacher/students/:classId',
    authenticateTeacher,
    async (req, res) => {

        const { classId } = req.params;

        try {
            const userId = req.user.id;
            const schoolId = req.user.school_id;

            // ------------------------------------------------
            // Find logged-in teacher
            // ------------------------------------------------

            const [users] = await db.query(
                `
                SELECT
                    id,
                    email,
                    school_id
                FROM users
                WHERE id = ?
                AND school_id = ?
                AND role = 'teacher'
                LIMIT 1
                `,
                [userId, schoolId]
            );

            if (users.length === 0) {
                return res.status(404).json({
                    message: 'Teacher account not found.'
                });
            }

            const user = users[0];

            // ------------------------------------------------
            // Find teacher profile
            // ------------------------------------------------

            const [teachers] = await db.query(
                `
                SELECT id
                FROM teachers
                WHERE email = ?
                AND school_id = ?
                LIMIT 1
                `,
                [user.email, schoolId]
            );

            if (teachers.length === 0) {
                return res.status(404).json({
                    message: 'Teacher profile not found.'
                });
            }

            const teacherId = teachers[0].id;

            // ------------------------------------------------
            // Make sure teacher is assigned to this class
            // ------------------------------------------------

            const [assignments] = await db.query(
                `
                SELECT ta.id
                FROM teacher_assignments ta

                INNER JOIN school_classes c
                    ON ta.class_id = c.id

                WHERE ta.teacher_id = ?
                AND ta.class_id = ?
                AND c.school_id = ?

                LIMIT 1
                `,
                [
                    teacherId,
                    classId,
                    schoolId
                ]
            );

            if (assignments.length === 0) {
                return res.status(403).json({
                    message: 'You are not assigned to this class.'
                });
            }

            // ------------------------------------------------
            // Get students
            //
            // Your students table currently uses current_class.
            // ------------------------------------------------

            const [students] = await db.query(
                `
                SELECT
                    id,
                    full_name,
                    current_class,
                    school_id
                FROM students
                WHERE school_id = ?

                AND current_class = (
                    SELECT class_name
                    FROM school_classes
                    WHERE id = ?
                    AND school_id = ?
                    LIMIT 1
                )

                ORDER BY full_name ASC
                `,
                [
                    schoolId,
                    classId,
                    schoolId
                ]
            );

            return res.json(students);

        } catch (error) {
            console.error('Error loading teacher students:', error);

            return res.status(500).json({
                message: 'Failed to load students.'
            });
        }
    }
);


// =====================================================
// GET EXISTING MARKS FOR A CLASS + SUBJECT
// =====================================================

router.get(
    '/teacher/marks/:classId/:subjectId',
    authenticateTeacher,
    async (req, res) => {

        const { classId, subjectId } = req.params;

        try {
            const userId = req.user.id;
            const schoolId = req.user.school_id;

            // ------------------------------------------------
            // Find logged-in teacher
            // ------------------------------------------------

            const [users] = await db.query(
                `
                SELECT
                    id,
                    email,
                    school_id
                FROM users
                WHERE id = ?
                AND school_id = ?
                AND role = 'teacher'
                LIMIT 1
                `,
                [userId, schoolId]
            );

            if (users.length === 0) {
                return res.status(404).json({
                    message: 'Teacher account not found.'
                });
            }

            const user = users[0];

            // ------------------------------------------------
            // Find teacher profile
            // ------------------------------------------------

            const [teachers] = await db.query(
                `
                SELECT id
                FROM teachers
                WHERE email = ?
                AND school_id = ?
                LIMIT 1
                `,
                [user.email, schoolId]
            );

            if (teachers.length === 0) {
                return res.status(404).json({
                    message: 'Teacher profile not found.'
                });
            }

            const teacherId = teachers[0].id;

            // ------------------------------------------------
            // Get CURRENT TERM + ACADEMIC YEAR
            // directly from school settings
            // ------------------------------------------------

            const [settings] = await db.query(
                `
                SELECT
                    current_term,
                    academic_year
                FROM school_settings
                WHERE school_id = ?
                LIMIT 1
                `,
                [schoolId]
            );

            if (settings.length === 0) {
                return res.status(400).json({
                    message: 'School settings have not been configured.'
                });
            }

            const currentTerm = settings[0].current_term;
            const academicYear = settings[0].academic_year;

            if (!currentTerm || !academicYear) {
                return res.status(400).json({
                    message: 'Current term and academic year must be configured in school settings.'
                });
            }

            // ------------------------------------------------
            // Verify assignment
            // ------------------------------------------------

            const [assignments] = await db.query(
                `
                SELECT
                    ta.id,
                    c.class_name,
                    s.subject_name

                FROM teacher_assignments ta

                INNER JOIN school_classes c
                    ON ta.class_id = c.id

                INNER JOIN school_subjects s
                    ON ta.subject_id = s.id

                WHERE ta.teacher_id = ?
                AND ta.class_id = ?
                AND ta.subject_id = ?
                AND c.school_id = ?
                AND s.school_id = ?

                LIMIT 1
                `,
                [
                    teacherId,
                    classId,
                    subjectId,
                    schoolId,
                    schoolId
                ]
            );

            if (assignments.length === 0) {
                return res.status(403).json({
                    message: 'You are not assigned to this class and subject.'
                });
            }

            const assignment = assignments[0];

            // ------------------------------------------------
            // Get existing marks
            //
            // IMPORTANT:
            // assessments.teacher_id = users.id
            // ------------------------------------------------

            const [marks] = await db.query(
                `
                SELECT
                    a.id AS assessment_id,
                    a.student_id,
                    a.class_score,
                    a.exam_score,
                    a.total_score,
                    a.term,
                    a.academic_year

                FROM assessments a

                INNER JOIN students st
                    ON a.student_id = st.id

                WHERE a.teacher_id = ?
                AND a.subject = ?
                AND a.term = ?
                AND a.academic_year = ?
                AND st.school_id = ?
                AND st.current_class = ?

                ORDER BY st.full_name ASC
                `,
                [
                    userId,
                    assignment.subject_name,
                    currentTerm,
                    academicYear,
                    schoolId,
                    assignment.class_name
                ]
            );

            return res.json({
                class_id: Number(classId),
                class_name: assignment.class_name,

                subject_id: Number(subjectId),
                subject_name: assignment.subject_name,

                term: currentTerm,
                academic_year: academicYear,

                marks
            });

        } catch (error) {

            console.error(
                'Error loading teacher marks:',
                error
            );

            return res.status(500).json({
                message: 'Failed to load marks.'
            });
        }
    }
);

// =====================================================
// BULK SAVE TEACHER MARKS
// =====================================================

router.post(
    '/teacher/bulk-marks',
    authenticateTeacher,
    async (req, res) => {

        const {
            class_id,
            subject_id,
            marks
        } = req.body;

        // ------------------------------------------------
        // Basic validation
        // ------------------------------------------------

        if (!class_id || !subject_id) {
            return res.status(400).json({
                message: 'Class and subject are required.'
            });
        }

        if (!Array.isArray(marks) || marks.length === 0) {
            return res.status(400).json({
                message: 'No marks provided.'
            });
        }

        const connection = await db.getConnection();

        try {

            const userId = req.user.id;
            const schoolId = req.user.school_id;

            // ------------------------------------------------
            // Find teacher account
            // ------------------------------------------------

            const [users] = await connection.execute(
                `
                SELECT
                    id,
                    email,
                    school_id
                FROM users
                WHERE id = ?
                AND school_id = ?
                AND role = 'teacher'
                LIMIT 1
                `,
                [userId, schoolId]
            );

            if (users.length === 0) {
                return res.status(404).json({
                    message: 'Teacher account not found.'
                });
            }

            const user = users[0];

            // ------------------------------------------------
            // Find teacher profile
            // ------------------------------------------------

            const [teachers] = await connection.execute(
                `
                SELECT id
                FROM teachers
                WHERE email = ?
                AND school_id = ?
                LIMIT 1
                `,
                [user.email, schoolId]
            );

            if (teachers.length === 0) {
                return res.status(404).json({
                    message: 'Teacher profile not found.'
                });
            }

            const teacherId = teachers[0].id;

            // ------------------------------------------------
            // GET TERM + ACADEMIC YEAR FROM SCHOOL SETTINGS
            // ------------------------------------------------

            const [settings] = await connection.execute(
                `
                SELECT
                    current_term,
                    academic_year
                FROM school_settings
                WHERE school_id = ?
                LIMIT 1
                `,
                [schoolId]
            );

            if (settings.length === 0) {
                return res.status(400).json({
                    message: 'School settings have not been configured.'
                });
            }

            const currentTerm = settings[0].current_term;
            const academicYear = settings[0].academic_year;

            if (!currentTerm || !academicYear) {
                return res.status(400).json({
                    message:
                        'Current term and academic year must be configured in school settings.'
                });
            }

            // ------------------------------------------------
            // Verify class + subject assignment
            // ------------------------------------------------

            const [assignments] = await connection.execute(
                `
                SELECT
                    ta.id,
                    c.class_name,
                    s.subject_name

                FROM teacher_assignments ta

                INNER JOIN school_classes c
                    ON ta.class_id = c.id

                INNER JOIN school_subjects s
                    ON ta.subject_id = s.id

                WHERE ta.teacher_id = ?
                AND ta.class_id = ?
                AND ta.subject_id = ?
                AND c.school_id = ?
                AND s.school_id = ?

                LIMIT 1
                `,
                [
                    teacherId,
                    class_id,
                    subject_id,
                    schoolId,
                    schoolId
                ]
            );

            if (assignments.length === 0) {
                return res.status(403).json({
                    message:
                        'You are not assigned to this class and subject.'
                });
            }

            const assignment = assignments[0];

            // ------------------------------------------------
            // Validate all marks
            // ------------------------------------------------

            for (const mark of marks) {

                const classScore = Number(
                    mark.class_score || 0
                );

                const examScore = Number(
                    mark.exam_score || 0
                );

                if (!mark.student_id) {
                    return res.status(400).json({
                        message: 'A student ID is missing.'
                    });
                }

                if (
                    Number.isNaN(classScore) ||
                    classScore < 0 ||
                    classScore > 30
                ) {
                    return res.status(400).json({
                        message:
                            `Invalid class score for student ${mark.student_id}. Class score must be between 0 and 30.`
                    });
                }

                if (
                    Number.isNaN(examScore) ||
                    examScore < 0 ||
                    examScore > 70
                ) {
                    return res.status(400).json({
                        message:
                            `Invalid exam score for student ${mark.student_id}. Exam score must be between 0 and 70.`
                    });
                }
            }

            // ------------------------------------------------
            // Verify every student belongs to this class
            // ------------------------------------------------

            const [classStudents] =
                await connection.execute(
                    `
                    SELECT
                        st.id,
                        st.full_name

                    FROM students st

                    WHERE st.school_id = ?
                    AND st.current_class = ?
                    `,
                    [
                        schoolId,
                        assignment.class_name
                    ]
                );

            const validStudentIds = new Set(
                classStudents.map(
                    student => String(student.id)
                )
            );

            for (const mark of marks) {

                if (
                    !validStudentIds.has(
                        String(mark.student_id)
                    )
                ) {
                    return res.status(400).json({
                        message:
                            `Student ${mark.student_id} does not belong to the selected class.`
                    });
                }
            }

            // ------------------------------------------------
            // Start transaction
            // ------------------------------------------------

            await connection.beginTransaction();

            let savedCount = 0;

            for (const mark of marks) {

                const classScore = Number(
                    mark.class_score || 0
                );

                const examScore = Number(
                    mark.exam_score || 0
                );

                const totalScore =
                    classScore + examScore;

                // ------------------------------------------------
                // Check existing mark
                // ------------------------------------------------

                const [existing] =
                    await connection.execute(
                        `
                        SELECT id
                        FROM assessments

                        WHERE student_id = ?
                        AND teacher_id = ?
                        AND subject = ?
                        AND term = ?
                        AND academic_year = ?

                        LIMIT 1
                        `,
                        [
                            mark.student_id,
                            userId,
                            assignment.subject_name,
                            currentTerm,
                            academicYear
                        ]
                    );

                if (existing.length > 0) {

                    await connection.execute(
                        `
                        UPDATE assessments

                        SET
                            class_score = ?,
                            exam_score = ?,
                            total_score = ?

                        WHERE id = ?
                        `,
                        [
                            classScore,
                            examScore,
                            totalScore,
                            existing[0].id
                        ]
                    );

                } else {

                    await connection.execute(
                        `
                        INSERT INTO assessments
                        (
                            student_id,
                            teacher_id,
                            subject,
                            class_score,
                            exam_score,
                            total_score,
                            term,
                            academic_year
                        )

                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `,
                        [
                            mark.student_id,
                            userId,
                            assignment.subject_name,
                            classScore,
                            examScore,
                            totalScore,
                            currentTerm,
                            academicYear
                        ]
                    );
                }

                savedCount++;
            }

            await connection.commit();

            return res.status(200).json({
                message:
                    `Marks saved successfully for ${savedCount} students.`,
                saved_count: savedCount,
                term: currentTerm,
                academic_year: academicYear
            });

        } catch (error) {

            await connection.rollback();

            console.error(
                'Bulk teacher marks error:',
                error
            );

            return res.status(500).json({
                message: 'Failed to save marks.',
                error: error.message
            });

        } finally {
            connection.release();
        }
    }
);














// =====================================================
// GET ATTENDANCE FOR AN ASSIGNED CLASS + DATE
// =====================================================

router.get(
    '/teacher/attendance/:classId',
    authenticateTeacher,
    async (req, res) => {

        const { classId } = req.params;
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                message: 'Attendance date is required.'
            });
        }

        try {

            const userId = req.user.id;
            const schoolId = req.user.school_id;

            // ------------------------------------------------
            // Find logged-in teacher
            // ------------------------------------------------

            const [users] = await db.query(
                `
                SELECT
                    id,
                    email,
                    school_id
                FROM users
                WHERE id = ?
                AND school_id = ?
                AND role = 'teacher'
                LIMIT 1
                `,
                [userId, schoolId]
            );

            if (users.length === 0) {
                return res.status(404).json({
                    message: 'Teacher account not found.'
                });
            }

            const user = users[0];

            // ------------------------------------------------
            // Find teacher profile
            // ------------------------------------------------

            const [teachers] = await db.query(
                `
                SELECT id
                FROM teachers
                WHERE email = ?
                AND school_id = ?
                LIMIT 1
                `,
                [user.email, schoolId]
            );

            if (teachers.length === 0) {
                return res.status(404).json({
                    message: 'Teacher profile not found.'
                });
            }

            const teacherId = teachers[0].id;

            // ------------------------------------------------
            // Get current term + academic year
            // ------------------------------------------------

            const [settings] = await db.query(
                `
                SELECT
                    current_term,
                    academic_year
                FROM school_settings
                WHERE school_id = ?
                LIMIT 1
                `,
                [schoolId]
            );

            if (settings.length === 0) {
                return res.status(400).json({
                    message: 'School settings have not been configured.'
                });
            }

            const currentTerm = settings[0].current_term;
            const academicYear = settings[0].academic_year;

            if (!currentTerm || !academicYear) {
                return res.status(400).json({
                    message:
                        'Current term and academic year must be configured in school settings.'
                });
            }

            // ------------------------------------------------
            // Verify teacher is assigned to this class
            //
            // IMPORTANT:
            // Attendance is class-level, not subject-level.
            // Therefore, ANY assignment to this class is enough.
            // ------------------------------------------------

            const [assignments] = await db.query(
                `
                SELECT
                    ta.id,
                    c.class_name

                FROM teacher_assignments ta

                INNER JOIN school_classes c
                    ON ta.class_id = c.id

                WHERE ta.teacher_id = ?
                AND ta.class_id = ?
                AND c.school_id = ?

                LIMIT 1
                `,
                [
                    teacherId,
                    classId,
                    schoolId
                ]
            );

            if (assignments.length === 0) {
                return res.status(403).json({
                    message: 'You are not assigned to this class.'
                });
            }

            const className = assignments[0].class_name;

            // ------------------------------------------------
            // Get students + attendance for selected date
            // ------------------------------------------------

            const [students] = await db.query(
                `
                SELECT
                    st.id,
                    st.full_name,
                    st.current_class,

                    a.id AS attendance_id,
                    a.status AS attendance_status,
                    a.remarks AS attendance_remarks

                FROM students st

                LEFT JOIN attendance a
                    ON a.student_id = st.id
                    AND a.date = ?
                    AND a.term = ?
                    AND a.academic_year = ?

                WHERE st.school_id = ?
                AND st.current_class = ?

                ORDER BY st.full_name ASC
                `,
                [
                    date,
                    currentTerm,
                    academicYear,
                    schoolId,
                    className
                ]
            );

            return res.json({
                class_id: Number(classId),
                class_name: className,
                date,
                term: currentTerm,
                academic_year: academicYear,
                students
            });

        } catch (error) {

            console.error(
                'Error loading teacher attendance:',
                error
            );

            return res.status(500).json({
                message: 'Failed to load attendance.'
            });
        }
    }
);


// =====================================================
// BULK SAVE TEACHER ATTENDANCE
// =====================================================

router.post(
    '/teacher/bulk-attendance',
    authenticateTeacher,
    async (req, res) => {

        const {
            class_id,
            date,
            attendance
        } = req.body;

        // ------------------------------------------------
        // Basic validation
        // ------------------------------------------------

        if (!class_id) {
            return res.status(400).json({
                message: 'Class is required.'
            });
        }

        if (!date) {
            return res.status(400).json({
                message: 'Attendance date is required.'
            });
        }

        if (
            !Array.isArray(attendance) ||
            attendance.length === 0
        ) {
            return res.status(400).json({
                message: 'No attendance records provided.'
            });
        }

        const connection = await db.getConnection();

        try {

            const userId = req.user.id;
            const schoolId = req.user.school_id;

            // ------------------------------------------------
            // Find teacher account
            // ------------------------------------------------

            const [users] = await connection.execute(
                `
                SELECT
                    id,
                    email,
                    school_id
                FROM users
                WHERE id = ?
                AND school_id = ?
                AND role = 'teacher'
                LIMIT 1
                `,
                [userId, schoolId]
            );

            if (users.length === 0) {
                return res.status(404).json({
                    message: 'Teacher account not found.'
                });
            }

            const user = users[0];

            // ------------------------------------------------
            // Find teacher profile
            // ------------------------------------------------

            const [teachers] = await connection.execute(
                `
                SELECT id
                FROM teachers
                WHERE email = ?
                AND school_id = ?
                LIMIT 1
                `,
                [user.email, schoolId]
            );

            if (teachers.length === 0) {
                return res.status(404).json({
                    message: 'Teacher profile not found.'
                });
            }

            const teacherId = teachers[0].id;

            // ------------------------------------------------
            // Get current term + academic year
            // ------------------------------------------------

            const [settings] = await connection.execute(
                `
                SELECT
                    current_term,
                    academic_year
                FROM school_settings
                WHERE school_id = ?
                LIMIT 1
                `,
                [schoolId]
            );

            if (settings.length === 0) {
                return res.status(400).json({
                    message: 'School settings have not been configured.'
                });
            }

            const currentTerm = settings[0].current_term;
            const academicYear = settings[0].academic_year;

            if (!currentTerm || !academicYear) {
                return res.status(400).json({
                    message:
                        'Current term and academic year must be configured in school settings.'
                });
            }

            // ------------------------------------------------
            // Verify teacher is assigned to this class
            // ------------------------------------------------

            const [assignments] = await connection.execute(
                `
                SELECT
                    ta.id,
                    c.class_name

                FROM teacher_assignments ta

                INNER JOIN school_classes c
                    ON ta.class_id = c.id

                WHERE ta.teacher_id = ?
                AND ta.class_id = ?
                AND c.school_id = ?

                LIMIT 1
                `,
                [
                    teacherId,
                    class_id,
                    schoolId
                ]
            );

            if (assignments.length === 0) {
                return res.status(403).json({
                    message: 'You are not assigned to this class.'
                });
            }

            const className = assignments[0].class_name;

            // ------------------------------------------------
            // Validate attendance statuses
            // ------------------------------------------------

            const validStatuses = [
                'Present',
                'Absent',
                'Late'
            ];

            for (const record of attendance) {

                if (!record.student_id) {
                    return res.status(400).json({
                        message: 'A student ID is missing.'
                    });
                }

                if (
                    !validStatuses.includes(
                        record.status
                    )
                ) {
                    return res.status(400).json({
                        message:
                            `Invalid attendance status for student ${record.student_id}.`
                    });
                }
            }

            // ------------------------------------------------
            // Verify every student belongs to this class
            // AND school
            // ------------------------------------------------

            const [classStudents] =
                await connection.execute(
                    `
                    SELECT
                        id,
                        full_name

                    FROM students

                    WHERE school_id = ?
                    AND current_class = ?
                    `,
                    [
                        schoolId,
                        className
                    ]
                );

            const validStudentIds = new Set(
                classStudents.map(
                    student => String(student.id)
                )
            );

            for (const record of attendance) {

                if (
                    !validStudentIds.has(
                        String(record.student_id)
                    )
                ) {
                    return res.status(400).json({
                        message:
                            `Student ${record.student_id} does not belong to the selected class.`
                    });
                }
            }

            // ------------------------------------------------
            // Start transaction
            // ------------------------------------------------

            await connection.beginTransaction();

            let savedCount = 0;

            for (const record of attendance) {

                const remarks =
                    record.remarks !== undefined &&
                    record.remarks !== null &&
                    String(record.remarks).trim() !== ''
                        ? String(record.remarks).trim()
                        : null;

                // ------------------------------------------------
                // Because we added the unique key:
                //
                // student_id + date + term + academic_year
                //
                // we can safely use ON DUPLICATE KEY UPDATE.
                // ------------------------------------------------

                await connection.execute(
                    `
                    INSERT INTO attendance
                    (
                        student_id,
                        status,
                        term,
                        academic_year,
                        date,
                        remarks
                    )

                    VALUES (?, ?, ?, ?, ?, ?)

                    ON DUPLICATE KEY UPDATE
                        status = VALUES(status),
                        remarks = VALUES(remarks)
                    `,
                    [
                        record.student_id,
                        record.status,
                        currentTerm,
                        academicYear,
                        date,
                        remarks
                    ]
                );

                savedCount++;
            }

            await connection.commit();

            return res.status(200).json({
                message:
                    `Attendance saved successfully for ${savedCount} students.`,
                saved_count: savedCount,
                class_id: Number(class_id),
                class_name: className,
                date,
                term: currentTerm,
                academic_year: academicYear
            });

        } catch (error) {

            await connection.rollback();

            console.error(
                'Bulk teacher attendance error:',
                error
            );

            return res.status(500).json({
                message: 'Failed to save attendance.',
                error: error.message
            });

        } finally {
            connection.release();
        }
    }
);
















// =====================================================
// SAVE / REGENERATE STUDENT REPORT
// =====================================================

router.post(
    '/reports/generate/:studentId',
    authenticateTeacher,
    async (req, res) => {

        const { studentId } = req.params;
        const schoolId = req.user.school_id;

        try {

            // ------------------------------------------------
            // CURRENT TERM + ACADEMIC YEAR
            // ------------------------------------------------

            const [settings] = await db.query(
                `
                SELECT
                    current_term,
                    academic_year
                FROM school_settings
                WHERE school_id = ?
                LIMIT 1
                `,
                [schoolId]
            );

            if (settings.length === 0) {
                return res.status(400).json({
                    message: 'School settings have not been configured.'
                });
            }

            const currentTerm = settings[0].current_term;
            const academicYear = settings[0].academic_year;

            if (!currentTerm || !academicYear) {
                return res.status(400).json({
                    message:
                        'Current term and academic year must be configured.'
                });
            }

            // ------------------------------------------------
            // GET STUDENT
            // ------------------------------------------------

            const [students] = await db.query(
                `
                SELECT
                    id,
                    school_id,
                    full_name,
                    current_class
                FROM students
                WHERE id = ?
                AND school_id = ?
                LIMIT 1
                `,
                [studentId, schoolId]
            );

            if (students.length === 0) {
                return res.status(404).json({
                    message: 'Student not found.'
                });
            }

            const student = students[0];
            const className = student.current_class;

            // ------------------------------------------------
            // STUDENT TOTAL
            // ------------------------------------------------

            const [studentTotals] = await db.query(
                `
                SELECT
                    COALESCE(SUM(a.total_score), 0) AS overall_total,
                    COALESCE(AVG(a.total_score), 0) AS overall_average
                FROM assessments a
                INNER JOIN students s
                    ON s.id = a.student_id
                WHERE a.student_id = ?
                AND s.school_id = ?
                AND a.term = ?
                AND a.academic_year = ?
                `,
                [
                    studentId,
                    schoolId,
                    currentTerm,
                    academicYear
                ]
            );

            const overallTotal = Number(
                studentTotals[0]?.overall_total || 0
            );

            const overallAverage = Number(
                studentTotals[0]?.overall_average || 0
            );

            // ------------------------------------------------
            // CLASS RANKING
            // ------------------------------------------------

            const [classRanking] = await db.query(
                `
                SELECT
                    student_id,
                    grand_total,
                    average_score,

                    RANK() OVER (
                        ORDER BY grand_total DESC
                    ) AS class_position

                FROM (
                    SELECT
                        a.student_id,
                        SUM(a.total_score) AS grand_total,
                        AVG(a.total_score) AS average_score

                    FROM assessments a

                    INNER JOIN students s
                        ON s.id = a.student_id

                    WHERE s.school_id = ?
                    AND s.current_class = ?
                    AND a.term = ?
                    AND a.academic_year = ?

                    GROUP BY a.student_id
                ) ranked_students

                ORDER BY grand_total DESC
                `,
                [
                    schoolId,
                    className,
                    currentTerm,
                    academicYear
                ]
            );

            const studentRanking = classRanking.find(
                row =>
                    String(row.student_id) ===
                    String(studentId)
            );

            const classPosition = studentRanking
                ? Number(studentRanking.class_position)
                : null;

            // ------------------------------------------------
            // CLASS SIZE
            // ------------------------------------------------

            const [[classSizeRow]] = await db.query(
                `
                SELECT COUNT(*) AS class_size
                FROM students
                WHERE school_id = ?
                AND current_class = ?
                `,
                [
                    schoolId,
                    className
                ]
            );

            const classSize = Number(
                classSizeRow?.class_size || 0
            );

            // ------------------------------------------------
            // REFRESH POSITIONS FOR EXISTING REPORTS
            //
            // IMPORTANT:
            // This only updates ranking-related fields.
            // Remarks and status are preserved.
            // ------------------------------------------------

            for (const rankedStudent of classRanking) {

                await db.query(
                    `
                    UPDATE student_reports sr

                    INNER JOIN students s
                        ON s.id = sr.student_id

                    SET
                        sr.class_position = ?,
                        sr.class_size = ?,
                        sr.overall_total = ?,
                        sr.overall_average = ?,
                        sr.updated_at = CURRENT_TIMESTAMP

                    WHERE sr.student_id = ?
                    AND sr.school_id = ?
                    AND sr.term = ?
                    AND sr.academic_year = ?
                    AND s.current_class = ?
                    `,
                    [
                        Number(rankedStudent.class_position),
                        classSize,
                        Number(rankedStudent.grand_total || 0),
                        Number(rankedStudent.average_score || 0),

                        rankedStudent.student_id,
                        schoolId,
                        currentTerm,
                        academicYear,
                        className
                    ]
                );
            }

            // ------------------------------------------------
            // CHECK EXISTING REPORT
            // ------------------------------------------------

            const [existingReports] = await db.query(
                `
                SELECT
                    id,
                    teacher_remark,
                    headteacher_remark,
                    status
                FROM student_reports

                WHERE student_id = ?
                AND school_id = ?
                AND term = ?
                AND academic_year = ?

                LIMIT 1
                `,
                [
                    studentId,
                    schoolId,
                    currentTerm,
                    academicYear
                ]
            );

            let reportId;
            let wasExisting = false;

            // ------------------------------------------------
            // UPDATE EXISTING REPORT
            //
            // DO NOT TOUCH:
            // teacher_remark
            // headteacher_remark
            // status
            // ------------------------------------------------

            if (existingReports.length > 0) {

                wasExisting = true;
                reportId = existingReports[0].id;

                await db.query(
                    `
                    UPDATE student_reports

                    SET
                        class_position = ?,
                        class_size = ?,
                        overall_total = ?,
                        overall_average = ?,
                        updated_at = CURRENT_TIMESTAMP

                    WHERE id = ?
                    AND school_id = ?
                    `,
                    [
                        classPosition,
                        classSize,
                        overallTotal,
                        overallAverage,
                        reportId,
                        schoolId
                    ]
                );

            } else {

                // ------------------------------------------------
                // CREATE NEW DRAFT REPORT
                // ------------------------------------------------

                const [result] = await db.query(
                    `
                    INSERT INTO student_reports
                    (
                        student_id,
                        school_id,
                        term,
                        academic_year,
                        class_position,
                        class_size,
                        overall_total,
                        overall_average,
                        status
                    )

                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
                    `,
                    [
                        studentId,
                        schoolId,
                        currentTerm,
                        academicYear,
                        classPosition,
                        classSize,
                        overallTotal,
                        overallAverage
                    ]
                );

                reportId = result.insertId;
            }

            // ------------------------------------------------
            // RETURN COMPLETE SAVED REPORT
            // ------------------------------------------------

            const [savedReports] = await db.query(
                `
                SELECT
                    sr.id,
                    sr.student_id,
                    sr.school_id,

                    s.full_name,
                    s.current_class,

                    sr.term,
                    sr.academic_year,

                    sr.class_position,
                    sr.class_size,

                    sr.overall_total,
                    sr.overall_average,

                    sr.teacher_remark,
                    sr.headteacher_remark,

                    sr.status,
                    sr.generated_at,
                    sr.updated_at

                FROM student_reports sr

                INNER JOIN students s
                    ON s.id = sr.student_id

                WHERE sr.id = ?
                AND sr.school_id = ?

                LIMIT 1
                `,
                [reportId, schoolId]
            );

            return res.status(200).json({

                message: wasExisting
                    ? 'Report regenerated successfully.'
                    : 'Report generated successfully.',

                report: savedReports[0]
            });

        } catch (error) {

            console.error(
                'Error generating saved report:',
                error
            );

            return res.status(500).json({
                message: 'Failed to generate report.',
                error: error.message
            });
        }
    }
);








// =====================================================
// GET SAVED STUDENT REPORTS
// =====================================================

router.get(
    '/reports',
    authenticateTeacher,
    async (req, res) => {

        try {

            const schoolId = req.user.school_id;

            const {
                class_name,
                term,
                academic_year,
                student_id
            } = req.query;

            let sql = `
                SELECT
                    sr.id,
                    sr.student_id,
                    sr.school_id,

                    s.full_name,
                    s.current_class,

                    sr.term,
                    sr.academic_year,

                    sr.class_position,
                    sr.class_size,

                    sr.overall_total,
                    sr.overall_average,

                    sr.teacher_remark,
                    sr.headteacher_remark,

                    sr.status,
                    sr.generated_at,
                    sr.updated_at

                FROM student_reports sr

                INNER JOIN students s
                    ON s.id = sr.student_id

                WHERE sr.school_id = ?
            `;

            const params = [schoolId];

            if (class_name) {
                sql += `
                    AND s.current_class = ?
                `;
                params.push(class_name);
            }

            if (student_id) {
                sql += `
                    AND sr.student_id = ?
                `;
                params.push(student_id);
            }

            if (term) {
                sql += `
                    AND sr.term = ?
                `;
                params.push(term);
            }

            if (academic_year) {
                sql += `
                    AND sr.academic_year = ?
                `;
                params.push(academic_year);
            }

            sql += `
                ORDER BY
                    sr.class_position IS NULL ASC,
                    sr.class_position ASC,
                    s.full_name ASC
            `;

            const [reports] = await db.query(
                sql,
                params
            );

            return res.json({
                reports
            });

        } catch (error) {

            console.error(
                'Error loading saved reports:',
                error
            );

            return res.status(500).json({
                message: 'Failed to load saved reports.',
                error: error.message
            });
        }
    }
);





// ============================================================
// GET ONE GENERATED REPORT BY ID
// ============================================================
router.get('/reports/:reportId', authenticateTeacher, async (req, res) => {
  try {
    const { reportId } = req.params;

    const [reports] = await db.query(
      `
      SELECT
        sr.*,
        s.full_name,
        s.current_class,
        s.admission_number,
        s.gender,
        sc.class_name
      FROM student_reports sr
      INNER JOIN students s
        ON s.id = sr.student_id
      LEFT JOIN school_classes sc
        ON sc.class_name = s.current_class
        AND sc.school_id = sr.school_id
      WHERE sr.id = ?
        AND sr.school_id = ?
      LIMIT 1
      `,
      [reportId, req.user.school_id]
    );

    if (reports.length === 0) {
      return res.status(404).json({
        message: 'Report not found.'
      });
    }

    res.json({
      report: reports[0]
    });

  } catch (error) {
    console.error('Get report by ID error:', error);

    res.status(500).json({
      message: 'Failed to fetch report.',
      error: error.message
    });
  }
});





// =====================================================
// SAVE STUDENT REPORT
// SAVE REMARKS / FINALIZE REPORT
// =====================================================

router.put(
    '/reports/:reportId',
    authenticateTeacher,
    async (req, res) => {

        const { reportId } = req.params;

        const {
            teacher_remark,
            headteacher_remark,
            status
        } = req.body;

        const schoolId = req.user.school_id;

        try {

            // ------------------------------------------------
            // GET EXISTING REPORT
            // ------------------------------------------------

            const [reports] = await db.query(
                `
                SELECT
                    id,
                    student_id,
                    status
                FROM student_reports

                WHERE id = ?
                AND school_id = ?

                LIMIT 1
                `,
                [
                    reportId,
                    schoolId
                ]
            );

            if (reports.length === 0) {
                return res.status(404).json({
                    message: 'Report not found.'
                });
            }

            const existingReport = reports[0];

            // ------------------------------------------------
            // VALIDATE STATUS
            // ------------------------------------------------

            if (
                status !== undefined &&
                status !== 'draft' &&
                status !== 'final'
            ) {
                return res.status(400).json({
                    message:
                        'Invalid report status. Use draft or final.'
                });
            }

            // ------------------------------------------------
            // DO NOT ALLOW A FINAL REPORT TO BE SAVED BACK
            // AS DRAFT UNINTENTIONALLY.
            //
            // If the frontend explicitly wants to finalize,
            // status = final is allowed.
            // ------------------------------------------------

            if (
                existingReport.status === 'final' &&
                status === 'draft'
            ) {
                return res.status(400).json({
                    message:
                        'This report is already finalized.'
                });
            }

            const updates = [];
            const values = [];

            // ------------------------------------------------
            // TEACHER REMARK
            // ------------------------------------------------

            if (teacher_remark !== undefined) {

                updates.push(
                    'teacher_remark = ?'
                );

                values.push(
                    String(teacher_remark).trim()
                );
            }

            // ------------------------------------------------
            // HEADTEACHER REMARK
            // ------------------------------------------------

            if (headteacher_remark !== undefined) {

                updates.push(
                    'headteacher_remark = ?'
                );

                values.push(
                    String(headteacher_remark).trim()
                );
            }

            // ------------------------------------------------
            // STATUS
            // ------------------------------------------------

            if (status !== undefined) {

                updates.push(
                    'status = ?'
                );

                values.push(status);
            }

            if (updates.length === 0) {

                return res.status(400).json({
                    message: 'No changes provided.'
                });
            }

            updates.push(
                'updated_at = CURRENT_TIMESTAMP'
            );

            values.push(
                reportId,
                schoolId
            );

            // ------------------------------------------------
            // UPDATE
            // ------------------------------------------------

            await db.query(
                `
                UPDATE student_reports

                SET
                    ${updates.join(', ')}

                WHERE id = ?
                AND school_id = ?
                `,
                values
            );

            // ------------------------------------------------
            // RETURN COMPLETE UPDATED REPORT
            // ------------------------------------------------

            const [updatedReports] = await db.query(
                `
                SELECT
                    sr.id,
                    sr.student_id,
                    sr.school_id,

                    s.full_name,
                    s.current_class,

                    sr.term,
                    sr.academic_year,

                    sr.class_position,
                    sr.class_size,

                    sr.overall_total,
                    sr.overall_average,

                    sr.teacher_remark,
                    sr.headteacher_remark,

                    sr.status,
                    sr.generated_at,
                    sr.updated_at

                FROM student_reports sr

                INNER JOIN students s
                    ON s.id = sr.student_id

                WHERE sr.id = ?
                AND sr.school_id = ?

                LIMIT 1
                `,
                [
                    reportId,
                    schoolId
                ]
            );

            return res.status(200).json({

                message:
                    status === 'final'
                        ? 'Report finalized successfully.'
                        : 'Report saved successfully.',

                report: updatedReports[0]
            });

        } catch (error) {

            console.error(
                'Error updating student report:',
                error
            );

            return res.status(500).json({
                message: 'Failed to save report.',
                error: error.message
            });
        }
    }
);










// =====================================================
// GENERATE / REGENERATE ALL REPORTS FOR A CLASS
// =====================================================

router.post(
    '/reports/generate-class/:classId',
    authenticateTeacher,
    async (req, res) => {

        console.log('🔥 GENERATE CLASS ROUTE HIT:', req.params.classId);

        const connection = await db.getConnection();

        try {

            const schoolId = req.user.school_id;
            const { classId } = req.params;

            // ------------------------------------------------
            // CURRENT TERM + ACADEMIC YEAR
            // ------------------------------------------------

            const [settings] = await connection.execute(
                `
                SELECT
                    current_term,
                    academic_year
                FROM school_settings
                WHERE school_id = ?
                LIMIT 1
                `,
                [schoolId]
            );

            if (settings.length === 0) {
                return res.status(400).json({
                    message:
                        'School settings have not been configured.'
                });
            }

            const currentTerm =
                settings[0].current_term;

            const academicYear =
                settings[0].academic_year;

            if (!currentTerm || !academicYear) {
                return res.status(400).json({
                    message:
                        'Current term and academic year must be configured.'
                });
            }

            // ------------------------------------------------
            // VERIFY CLASS
            // ------------------------------------------------

            const [classes] =
                await connection.execute(
                    `
                    SELECT
                        id,
                        class_name

                    FROM school_classes

                    WHERE id = ?
                    AND school_id = ?

                    LIMIT 1
                    `,
                    [
                        classId,
                        schoolId
                    ]
                );

            if (classes.length === 0) {
                return res.status(404).json({
                    message: 'Class not found.'
                });
            }

            const className =
                classes[0].class_name;

            // ------------------------------------------------
            // GET ALL STUDENTS
            // ------------------------------------------------

            const [students] =
                await connection.execute(
                    `
                    SELECT
                        id,
                        full_name

                    FROM students

                    WHERE school_id = ?
                    AND current_class = ?

                    ORDER BY full_name ASC
                    `,
                    [
                        schoolId,
                        className
                    ]
                );

            if (students.length === 0) {
                return res.status(400).json({
                    message:
                        'No students found in this class.'
                });
            }

            const classSize = students.length;

            // ------------------------------------------------
            // CALCULATE CLASS RANKING
            // ------------------------------------------------

            const [classRanking] =
                await connection.execute(
                    `
                    SELECT
                        student_id,
                        grand_total,
                        average_score,

                        RANK() OVER (
                            ORDER BY grand_total DESC
                        ) AS class_position

                    FROM (
                        SELECT
                            a.student_id,

                            SUM(a.total_score)
                                AS grand_total,

                            AVG(a.total_score)
                                AS average_score

                        FROM assessments a

                        INNER JOIN students s
                            ON s.id = a.student_id

                        WHERE s.school_id = ?
                        AND s.current_class = ?
                        AND a.term = ?
                        AND a.academic_year = ?

                        GROUP BY a.student_id
                    ) ranked_students

                    ORDER BY
                        grand_total DESC
                    `,
                    [
                        schoolId,
                        className,
                        currentTerm,
                        academicYear
                    ]
                );

            const rankingMap = new Map();

            for (const ranking of classRanking) {

                rankingMap.set(
                    String(ranking.student_id),
                    {
                        position:
                            Number(
                                ranking.class_position
                            ),

                        total:
                            Number(
                                ranking.grand_total || 0
                            ),

                        average:
                            Number(
                                ranking.average_score || 0
                            )
                    }
                );
            }

            // ------------------------------------------------
            // START TRANSACTION
            // ------------------------------------------------

            await connection.beginTransaction();

            let createdCount = 0;
            let updatedCount = 0;

            // ------------------------------------------------
            // CREATE / UPDATE EVERY STUDENT REPORT
            //
            // IMPORTANT:
            // Existing remarks and status are NOT changed.
            // ------------------------------------------------

            for (const student of students) {

                const ranking =
                    rankingMap.get(
                        String(student.id)
                    );

                const classPosition =
                    ranking
                        ? ranking.position
                        : null;

                const overallTotal =
                    ranking
                        ? ranking.total
                        : 0;

                const overallAverage =
                    ranking
                        ? ranking.average
                        : 0;

                const [existingReports] =
                    await connection.execute(
                        `
                        SELECT
                            id

                        FROM student_reports

                        WHERE student_id = ?
                        AND school_id = ?
                        AND term = ?
                        AND academic_year = ?

                        LIMIT 1
                        `,
                        [
                            student.id,
                            schoolId,
                            currentTerm,
                            academicYear
                        ]
                    );

                if (existingReports.length > 0) {

                    await connection.execute(
                        `
                        UPDATE student_reports

                        SET
                            class_position = ?,
                            class_size = ?,
                            overall_total = ?,
                            overall_average = ?,
                            updated_at =
                                CURRENT_TIMESTAMP

                        WHERE id = ?
                        AND school_id = ?
                        `,
                        [
                            classPosition,
                            classSize,
                            overallTotal,
                            overallAverage,
                            existingReports[0].id,
                            schoolId
                        ]
                    );

                    updatedCount++;

                } else {

                    await connection.execute(
                        `
                        INSERT INTO student_reports
                        (
                            student_id,
                            school_id,
                            term,
                            academic_year,
                            class_position,
                            class_size,
                            overall_total,
                            overall_average,
                            status
                        )

                        VALUES
                        (
                            ?, ?, ?, ?, ?, ?, ?, ?, 'draft'
                        )
                        `,
                        [
                            student.id,
                            schoolId,
                            currentTerm,
                            academicYear,
                            classPosition,
                            classSize,
                            overallTotal,
                            overallAverage
                        ]
                    );

                    createdCount++;
                }
            }

            // ------------------------------------------------
            // COMMIT
            // ------------------------------------------------

            await connection.commit();

            // ------------------------------------------------
            // IMPORTANT:
            // NOW LOAD ALL SAVED REPORTS
            //
            // This is what allows the frontend to display
            // the whole class report list.
            // ------------------------------------------------

            const [savedReports] =
                await connection.execute(
                    `
                    SELECT
                        sr.id,
                        sr.student_id,
                        sr.school_id,

                        s.full_name,
                        s.current_class,
                        s.gender,
                        s.passport_photo_url,

                        sr.term,
                        sr.academic_year,

                        sr.class_position,
                        sr.class_size,

                        sr.overall_total,
                        sr.overall_average,

                        sr.teacher_remark,
                        sr.headteacher_remark,

                        sr.status,
                        sr.generated_at,
                        sr.updated_at

                    FROM student_reports sr

                    INNER JOIN students s
                        ON s.id = sr.student_id

                    WHERE sr.school_id = ?
                    AND s.current_class = ?
                    AND sr.term = ?
                    AND sr.academic_year = ?

                    ORDER BY
                        sr.class_position IS NULL ASC,
                        sr.class_position ASC,
                        s.full_name ASC
                    `,
                    [
                        schoolId,
                        className,
                        currentTerm,
                        academicYear
                    ]
                );

            // ------------------------------------------------
            // RETURN REPORTS TO FRONTEND
            // ------------------------------------------------


            console.log(
    'GENERATED CLASS REPORTS:',
    JSON.stringify(savedReports, null, 2)
);


            return res.status(200).json({

                message:
                    'Class reports generated successfully.',

                class_id:
                    Number(classId),

                class_name:
                    className,

                term:
                    currentTerm,

                academic_year:
                    academicYear,

                class_size:
                    classSize,

                total_students:
                    students.length,

                created_count:
                    createdCount,

                updated_count:
                    updatedCount,

                reports:
                    savedReports
            });

        } catch (error) {

            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    'Rollback error:',
                    rollbackError
                );
            }

            console.error(
                'Error generating class reports:',
                error
            );

            return res.status(500).json({
                message:
                    'Failed to generate class reports.',
                error:
                    error.message
            });

        } finally {

            connection.release();
        }
    }
);












module.exports = router;