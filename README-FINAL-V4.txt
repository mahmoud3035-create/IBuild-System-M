IBuild System - Final V4

WHAT'S INCLUDED
- Existing Employees / Attendance / Payroll / Projects / Invoices / Payments / Reports.
- Project progress percentage stored safely in projects.progress_percentage.
- Financial project summary: contract, invoices, paid amount, outstanding amount, and financial collection percentage.
- Role-based API permissions: Admin, Manager, Accountant, HR, Viewer.
- Leaves: requests, approval/rejection, annual leave balance.
- End of Service: service duration and estimated entitlement calculation.
- Employee documents: document type/number/issue/expiry/notes.
- Users management and role assignment.
- Audit log for important new operations.
- Automatic safe database migration on startup. No existing data is deleted.
- Reports payroll month query fixed for DATE columns using DATE_FORMAT.
- Windows launcher included.

FIRST RUN
1. Keep your existing .env file. Do NOT replace it with .env.example.
2. If the users table does not exist, the server creates it automatically.
3. If users is empty, the server creates the first Admin user:
   username: admin
   password: Admin@12345
   You should change it immediately in Users.
   You can override the initial credentials with:
   ADMIN_INITIAL_USERNAME
   ADMIN_INITIAL_PASSWORD
   ADMIN_INITIAL_NAME
4. Run START-WINDOWS.bat or: npm install then npm start
5. Open http://localhost:3000

IMPORTANT
- End-of-service is an internal estimate and should be reviewed against the applicable contract and UAE labour rules before actual settlement.
- The project progress percentage is the physical/project progress entered by the user. The financial collection percentage remains calculated from Paid payments.
- No .env secrets are included in this package.
