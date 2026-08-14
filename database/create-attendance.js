const db = require("./db");

const sql = `
CREATE TABLE IF NOT EXISTS attendance_records (

    id INT AUTO_INCREMENT PRIMARY KEY,

    employee_id INT NOT NULL,

    attendance_date DATE NOT NULL,

    check_in TIME NULL,

    check_out TIME NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'Present',

    notes TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_employee_date (
        employee_id,
        attendance_date
    ),

    FOREIGN KEY (employee_id)
        REFERENCES employees(id)
        ON DELETE CASCADE

)
`;

db.query(sql)
    .then(() => {

        console.log(
            "================================="
        );

        console.log(
            "attendance_records created successfully"
        );

        console.log(
            "================================="
        );

        process.exit(0);

    })
    .catch(error => {

        console.error(
            "ATTENDANCE TABLE ERROR:"
        );

        console.error(
            error.message
        );

        process.exit(1);

    });