const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();


// =====================================================
// ADMIN AUTHENTICATION
// =====================================================

function authenticateAdmin(req, res, next) {

    try {

        const authHeader = req.headers.authorization;

        if (
            !authHeader ||
            !authHeader.startsWith('Bearer ')
        ) {
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

        if (decoded.role !== 'admin') {
            return res.status(403).json({
                message: 'Admin access required.'
            });
        }

        req.user = decoded;

        next();

    } catch (error) {

        console.error(
            'Admin authentication error:',
            error
        );

        return res.status(401).json({
            message: 'Invalid or expired token.'
        });
    }
}


// =====================================================
// GET PROMOTION OVERVIEW
// =====================================================

router.get(
    '/promotion/overview',
    authenticateAdmin,
    async (req, res) => {

        try {

            const schoolId = req.user.school_id;

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
                    message:
                        'School settings have not been configured.'
                });
            }

            const academicYear =
                settings[0].academic_year;

            const [classes] = await db.query(
                `
                SELECT
                    c.id,
                    c.class_name,
                    COUNT(st.id) AS student_count
                FROM school_classes c

                LEFT JOIN students st
                    ON st.current_class = c.class_name
                    AND st.school_id = c.school_id

                WHERE c.school_id = ?

                GROUP BY
                    c.id,
                    c.class_name

                ORDER BY
                    c.class_name ASC
                `,
                [schoolId]
            );

            return res.json({
                academic_year: academicYear,
                classes
            });

        } catch (error) {

            console.error(
                'Promotion overview error:',
                error
            );

            return res.status(500).json({
                message:
                    'Failed to load promotion overview.'
            });
        }
    }
);


// =====================================================
// GET STUDENTS FOR PROMOTION
// =====================================================

router.get(
    '/promotion/students/:classId',
    authenticateAdmin,
    async (req, res) => {

        const { classId } = req.params;

        try {

            const schoolId = req.user.school_id;

            // -----------------------------------------
            // Verify class
            // -----------------------------------------

            const [classes] = await db.query(
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


            // -----------------------------------------
            // Get students
            // -----------------------------------------

            const [students] = await db.query(
                `
                SELECT
                    st.id,
                    st.full_name,
                    st.current_class,
                    st.school_id

                FROM students st

                WHERE st.school_id = ?
                AND st.current_class = ?

                ORDER BY st.full_name ASC
                `,
                [
                    schoolId,
                    className
                ]
            );


            return res.json({
                class_id: Number(classId),
                class_name: className,
                students
            });

        } catch (error) {

            console.error(
                'Promotion students error:',
                error
            );

            return res.status(500).json({
                message:
                    'Failed to load students.'
            });
        }
    }
);


// =====================================================
// EXECUTE PROMOTION
// =====================================================

router.post(
    '/promotion/execute',
    authenticateAdmin,
    async (req, res) => {

        const {
            academic_year,
            effective_date,
            promotions
        } = req.body;

        if (!academic_year) {
            return res.status(400).json({
                message:
                    'Academic year is required.'
            });
        }

        if (!effective_date) {
            return res.status(400).json({
                message:
                    'Effective date is required.'
            });
        }

        if (
            !Array.isArray(promotions) ||
            promotions.length === 0
        ) {
            return res.status(400).json({
                message:
                    'No promotion decisions were provided.'
            });
        }


        const connection =
            await db.getConnection();

        try {

            const schoolId =
                req.user.school_id;


            // =================================================
            // VALIDATE ACADEMIC YEAR
            // =================================================

            const [settings] =
                await connection.execute(
                    `
                    SELECT academic_year
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


            // =================================================
            // VALIDATE EACH DECISION
            // =================================================

            for (const decision of promotions) {

                if (!decision.student_id) {

                    return res.status(400).json({
                        message:
                            'A student ID is missing.'
                    });
                }


                if (
                    !['Promoted', 'Repeated']
                        .includes(decision.status)
                ) {

                    return res.status(400).json({
                        message:
                            `Invalid promotion status for student ${decision.student_id}.`
                    });
                }


                if (
                    decision.status === 'Promoted' &&
                    !decision.target_class_id
                ) {

                    return res.status(400).json({
                        message:
                            `Target class is required for student ${decision.student_id}.`
                    });
                }
            }


            await connection.beginTransaction();


            let processedCount = 0;


            // =================================================
            // PROCESS EACH STUDENT
            // =================================================

            for (const decision of promotions) {

                const studentId =
                    decision.student_id;


                // ---------------------------------------------
                // Get student
                // ---------------------------------------------

                const [students] =
                    await connection.execute(
                        `
                        SELECT
                            id,
                            full_name,
                            current_class,
                            school_id

                        FROM students

                        WHERE id = ?
                        AND school_id = ?

                        LIMIT 1
                        `,
                        [
                            studentId,
                            schoolId
                        ]
                    );


                if (students.length === 0) {

                    throw new Error(
                        `Student ${studentId} was not found.`
                    );
                }


                const student =
                    students[0];


                // ---------------------------------------------
                // Find current class record
                // ---------------------------------------------

                const [currentClasses] =
                    await connection.execute(
                        `
                        SELECT
                            id,
                            class_name

                        FROM school_classes

                        WHERE school_id = ?
                        AND class_name = ?

                        LIMIT 1
                        `,
                        [
                            schoolId,
                            student.current_class
                        ]
                    );


                if (currentClasses.length === 0) {

                    throw new Error(
                        `Current class "${student.current_class}" was not found for ${student.full_name}.`
                    );
                }


                const currentClass =
                    currentClasses[0];


                // ---------------------------------------------
                // Prevent duplicate academic-year promotion
                // ---------------------------------------------

                const [existingHistory] =
                    await connection.execute(
                        `
                        SELECT id
                        FROM student_class_history

                        WHERE student_id = ?
                        AND academic_year = ?

                        LIMIT 1
                        `,
                        [
                            studentId,
                            academic_year
                        ]
                    );


                if (existingHistory.length > 0) {

                    throw new Error(
                        `${student.full_name} has already been processed for ${academic_year}.`
                    );
                }


                // ---------------------------------------------
                // Determine destination
                // ---------------------------------------------

                let targetClass =
                    currentClass;


                if (
                    decision.status === 'Promoted'
                ) {

                    const [targetClasses] =
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
                                decision.target_class_id,
                                schoolId
                            ]
                        );


                    if (
                        targetClasses.length === 0
                    ) {

                        throw new Error(
                            `Target class for ${student.full_name} was not found.`
                        );
                    }


                    targetClass =
                        targetClasses[0];
                }


                // ---------------------------------------------
                // Save history
                // ---------------------------------------------

                await connection.execute(
                    `
                    INSERT INTO student_class_history
                    (
                        student_id,
                        school_id,
                        class_id,
                        academic_year,
                        start_date,
                        end_date,
                        status
                    )

                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    `,
                    [
                        studentId,
                        schoolId,
                        currentClass.id,
                        academic_year,
                        null,
                        effective_date,
                        decision.status
                    ]
                );


                // ---------------------------------------------
                // Update current class
                // ---------------------------------------------

                await connection.execute(
                    `
                    UPDATE students

                    SET current_class = ?

                    WHERE id = ?
                    AND school_id = ?
                    `,
                    [
                        targetClass.class_name,
                        studentId,
                        schoolId
                    ]
                );


                processedCount++;
            }


            await connection.commit();


            return res.status(200).json({

                message:
                    `Promotion completed successfully for ${processedCount} students.`,

                processed_count:
                    processedCount,

                academic_year,

                effective_date

            });

        } catch (error) {

            await connection.rollback();

            console.error(
                'Promotion execution error:',
                error
            );

            return res.status(500).json({
                message:
                    error.message ||
                    'Promotion failed.'
            });

        } finally {

            connection.release();
        }
    }
);


module.exports = router;