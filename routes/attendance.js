const express = require('express');
const db = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');

router.use(verifyToken);


// POST: Save daily attendance
router.post('/record', async (req, res) => {
    const { attendanceRecords, term, academic_year } = req.body;
    const schoolId = req.user.school_id;

    if (!attendanceRecords || !Array.isArray(attendanceRecords) || attendanceRecords.length === 0) {
        return res.status(400).json({
            message: "No attendance records provided"
        });
    }

    if (!term || !academic_year) {
        return res.status(400).json({
            message: "Term and academic year are required"
        });
    }

    try {
        // Verify that all students belong to this school
        const studentIds = attendanceRecords.map(r => r.student_id);

        const placeholders = studentIds.map(() => '?').join(',');

        const [students] = await db.query(
            `SELECT id FROM students
             WHERE id IN (${placeholders})
             AND school_id = ?`,
            [...studentIds, schoolId]
        );

        const validStudentIds = new Set(students.map(s => s.id));

        const invalidStudent = attendanceRecords.find(
            r => !validStudentIds.has(Number(r.student_id))
        );

        if (invalidStudent) {
            return res.status(403).json({
                message: "One or more students do not belong to your school"
            });
        }

        const sql = `
            INSERT INTO attendance
            (student_id, status, term, academic_year, date)
            VALUES ?
        `;

        const values = attendanceRecords.map(r => [
            r.student_id,
            r.status,
            term,
            academic_year,
            new Date()
        ]);

        await db.query(sql, [values]);

        res.status(200).json({
            message: "Attendance recorded successfully!"
        });

    } catch (error) {
        console.error("Attendance Record Error:", error);

        res.status(500).json({
            message: "Error saving attendance"
        });
    }
});


// GET: Fetch attendance history for a class on a specific date
router.get('/history', async (req, res) => {
    const { current_class, date } = req.query;
    const schoolId = req.user.school_id;

    try {
        const sql = `
            SELECT
                s.id AS student_id,
                s.full_name,
                s.current_class,
                a.status,
                a.term,
                a.academic_year,
                a.date,
                a.remarks
            FROM students s
            JOIN attendance a
                ON s.id = a.student_id
            WHERE s.school_id = ?
              AND s.current_class = ?
              AND a.date = ?
            ORDER BY s.full_name ASC
        `;

        const [results] = await db.query(
            sql,
            [schoolId, current_class, date]
        );

        res.json(results);

    } catch (error) {
        console.error("Attendance History Error:", error);

        res.status(500).json({
            message: "Error fetching history"
        });
    }
});


module.exports = router;