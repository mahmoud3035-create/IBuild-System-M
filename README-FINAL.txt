IBuild Company Management System - Final Build

This package continues the current IBuild system and keeps the existing .env outside the package.

IMPORTANT
- Do NOT replace your existing .env file.
- Do NOT copy node_modules from another computer.
- Existing MySQL data is preserved.

WHAT WAS IMPROVED
1. Added the missing database connection module at database/db.js.
2. Added the missing authentication module at modules/auth/backend/auth.js.
3. Login now creates a secure HttpOnly session cookie using the JWT token.
4. Protected system pages and API endpoints now require a valid login session.
5. Added /api/auth/logout and proper logout cleanup.
6. Login now uses a relative API URL, so it also works when the system is opened through a different host/port.
7. Added /api/health for quick server/database diagnostics.
8. Added safe database compatibility migration on startup:
   - Adds employees.payroll_salary if the existing database does not have it.
   - Keeps the existing basic salary as the initial payroll salary.
   - Extends attendance status with Off.
   - Creates attendance_records as a compatibility view over the existing attendance table.
9. Added basic security/cache response headers.
10. Added START-WINDOWS.bat for easier Windows startup.
11. Validated server.js and all HTML JavaScript blocks for syntax errors.
12. Kept the current modules: Dashboard, Employees, Attendance, Payroll, Invoices, Payments, Projects, Reports.

START
Option A:
- Double-click START-WINDOWS.bat

Option B:
- Open CMD in this folder.
- Run: npm install
- Run: node server.js
- Open: http://localhost:3000

DATABASE
The application expects the existing MySQL database configured by your .env file.
The server checks the database before starting and applies only the compatibility changes listed above.

SECURITY
- The real .env is intentionally not included.
- Use .env.example as a reference only.
- The login session is stored in an HttpOnly cookie.

NEXT DEVELOPMENT AREAS
- Full role-based permissions (Admin / Manager / Accountant / HR / Viewer).
- Employee documents and attachments.
- Leave management page.
- End-of-service page.
- Printable payroll sheets and PDF reports.
- Project engineering progress separate from financial payment progress.
