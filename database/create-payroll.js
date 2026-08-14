const db = require("./db");

const sql = `
CREATE TABLE IF NOT EXISTS payroll_records (
    id INT AUTO_INCREMENT PRIMARY KEY,

    employee_id INT NOT NULL,

    payroll_month DATE NOT NULL,

    payroll_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    working_days INT NOT NULL DEFAULT 30,

    absent_days INT NOT NULL DEFAULT 0,

    absence_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    overtime_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    deductions DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    additions DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    net_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    status VARCHAR(30) NOT NULL DEFAULT 'draft',

    notes TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY unique_employee_month (
        employee_id,
        payroll_month
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
            "payroll_records created successfully"
        );

        console.log(
            "================================="
        );

        process.exit(0);

    })
    .catch(error => {

        console.error(
            "PAYROLL TABLE ERROR:"
        );

        console.error(
            error.message
        );

        process.exit(1);

    });