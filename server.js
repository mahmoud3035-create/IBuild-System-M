const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const auth = require("./modules/auth/backend/auth");
const db = require("./database/db");

const app = express();

const PORT = process.env.PORT || 3000;

// =====================================================
// MIDDLEWARES
// =====================================================

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));

// Basic security / caching headers for the local company system.
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "same-origin");
    if (req.path.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
});

function getCookies(req) {
    const header = req.headers.cookie || "";
    return header.split(";").reduce((acc, part) => {
        const index = part.indexOf("=");
        if (index === -1) return acc;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) acc[key] = decodeURIComponent(value);
        return acc;
    }, {});
}

function setAuthCookie(res, token) {
    const maxAge = 8 * 60 * 60;
    res.setHeader(
        "Set-Cookie",
        `ibuild_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`
    );
}

function clearAuthCookie(res) {
    res.setHeader(
        "Set-Cookie",
        "ibuild_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
    );
}

function requireAuth(req, res, next) {
    const publicPaths = ["/", "/login", "/api/auth/login", "/api/health"];
    if (publicPaths.includes(req.path)) return next();

    const cookies = getCookies(req);
    const authorization = req.headers.authorization || "";
    const bearer = authorization.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : "";
    const token = cookies.ibuild_token || bearer;

    if (!token) {
        if (req.path.startsWith("/api/")) {
            return res.status(401).json({ success: false, message: "غير مصرح. يرجى تسجيل الدخول." });
        }
        return res.redirect("/login");
    }

    try {
        req.user = auth.verifyToken(token);
        return next();
    } catch (error) {
        clearAuthCookie(res);
        if (req.path.startsWith("/api/")) {
            return res.status(401).json({ success: false, message: "انتهت جلسة الدخول. يرجى تسجيل الدخول مرة أخرى." });
        }
        return res.redirect("/login");
    }
}

app.use(requireAuth);

// =====================================================
// AUTHORIZATION / AUDIT HELPERS
// =====================================================

const ROLE_PERMISSIONS = {
    Admin: ['*'],
    Manager: ['dashboard.view','projects.view','projects.write','invoices.view','invoices.write','payments.view','payments.write','reports.view','attendance.view','attendance.write','employees.view'],
    Accountant: ['dashboard.view','projects.view','invoices.view','invoices.write','payments.view','payments.write','reports.view','payroll.view','payroll.write'],
    HR: ['dashboard.view','employees.view','employees.write','attendance.view','attendance.write','payroll.view','payroll.write','leaves.view','leaves.write','eos.view'],
    Viewer: ['dashboard.view','projects.view','invoices.view','payments.view','reports.view','employees.view','attendance.view','payroll.view','leaves.view','eos.view']
};

function hasPermission(user, permission) {
    if (!user) return false;
    const list = ROLE_PERMISSIONS[user.role] || [];
    return list.includes('*') || list.includes(permission);
}

function requirePermission(permission) {
    return (req, res, next) => {
        if (hasPermission(req.user, permission)) return next();
        return res.status(403).json({ success: false, message: 'ليس لديك صلاحية لتنفيذ هذه العملية' });
    };
}


// =====================================================
// DATABASE BACKUP / RESTORE HELPERS
// =====================================================

function backupSafeValue(value) {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) {
        return { __type: 'buffer', value: value.toString('base64') };
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(backupSafeValue);
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = backupSafeValue(item);
        }
        return out;
    }
    return value;
}

function restoreSafeValue(value) {
    if (value && typeof value === 'object' && value.__type === 'buffer') {
        return Buffer.from(value.value || '', 'base64');
    }
    if (Array.isArray(value)) return value.map(restoreSafeValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = restoreSafeValue(item);
        }
        return out;
    }
    return value;
}

async function buildDatabaseBackup() {
    const [objects] = await db.query(`
        SELECT TABLE_NAME, TABLE_TYPE
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_TYPE DESC, TABLE_NAME ASC
    `);

    const tables = [];
    const views = [];

    for (const object of objects) {
        const name = object.TABLE_NAME;
        const [createRows] = await db.query(`SHOW CREATE TABLE \`${name.replace(/`/g, '``')}\``);

        if (object.TABLE_TYPE === 'VIEW') {
            const createSql = createRows[0]?.['Create View'] || createRows[0]?.['Create Table'] || '';
            views.push({ name, createSql });
            continue;
        }

        const [rows] = await db.query(`SELECT * FROM \`${name.replace(/`/g, '``')}\``);
        tables.push({
            name,
            createSql: createRows[0]?.['Create Table'] || '',
            rows: rows.map(backupSafeValue)
        });
    }

    return {
        format: 'IBUILD_DATABASE_BACKUP',
        version: 1,
        created_at: new Date().toISOString(),
        database: process.env.DB_NAME || 'ibuild_system',
        note: 'Contains database structure and data. Passwords are stored only as password hashes.',
        tables,
        views
    };
}

function backupFileName() {
    const stamp = new Date().toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '_')
        .replace(/\..+/, '');
    return `ibuild-backup-${stamp}.json`;
}

async function saveDatabaseBackup() {
    const backup = await buildDatabaseBackup();
    const backupDir = path.join(__dirname, 'database', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const fileName = backupFileName();
    const filePath = path.join(backupDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(backup), 'utf8');
    return { backup, fileName, filePath };
}

async function restoreDatabaseBackup(backup) {
    if (!backup || backup.format !== 'IBUILD_DATABASE_BACKUP' || !Array.isArray(backup.tables)) {
        throw new Error('ملف النسخة الاحتياطية غير صالح');
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('SET FOREIGN_KEY_CHECKS=0');

        const [existingObjects] = await connection.query(`
            SELECT TABLE_NAME, TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
        `);

        for (const object of existingObjects) {
            const escaped = object.TABLE_NAME.replace(/`/g, '``');
            if (object.TABLE_TYPE === 'VIEW') {
                await connection.query(`DROP VIEW IF EXISTS \`${escaped}\``);
            }
        }

        // Drop base tables so the restored schema matches the backup.
        for (const object of existingObjects.filter(x => x.TABLE_TYPE !== 'VIEW')) {
            const escaped = object.TABLE_NAME.replace(/`/g, '``');
            await connection.query(`DROP TABLE IF EXISTS \`${escaped}\``);
        }

        for (const table of backup.tables) {
            if (!table.name || !table.createSql) continue;
            await connection.query(table.createSql);
        }

        for (const table of backup.tables) {
            if (!table.name || !Array.isArray(table.rows) || !table.rows.length) continue;

            const columns = Object.keys(table.rows[0] || {});
            if (!columns.length) continue;

            const escapedColumns = columns.map(c => `\`${String(c).replace(/`/g, '``')}\``).join(',');
            const placeholders = columns.map(() => '?').join(',');

            for (const row of table.rows) {
                const values = columns.map(c => restoreSafeValue(row[c]));
                await connection.query(
                    `INSERT INTO \`${table.name.replace(/`/g, '``')}\` (${escapedColumns}) VALUES (${placeholders})`,
                    values
                );
            }
        }

        for (const view of (backup.views || [])) {
            if (!view.name || !view.createSql) continue;
            // SHOW CREATE VIEW normally returns CREATE ALGORITHM... VIEW.
            await connection.query(view.createSql);
        }

        await connection.query('SET FOREIGN_KEY_CHECKS=1');
        await connection.commit();
    } catch (error) {
        try { await connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch (_) {}
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}


async function audit(req, action, entity, entityId = null, details = {}) {
    try {
        await db.query(`INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, ip_address) VALUES (?,?,?,?,?,?,?)`, [
            Number(req.user?.sub || req.user?.id || 0) || null,
            req.user?.username || null,
            action, entity, Number(entityId) || null,
            JSON.stringify(details || {}),
            req.ip || null
        ]);
    } catch (error) {
        console.error('AUDIT LOG ERROR:', error.message);
    }
}

// Record successful write requests automatically. This keeps the audit trail useful
// even for legacy modules that were built before the audit system existed.
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || !['POST','PUT','PATCH','DELETE'].includes(req.method) || req.path.startsWith('/api/auth/')) return next();
    res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
            const parts = req.path.split('/').filter(Boolean);
            const entity = parts[1] || 'api';
            const idPart = parts.find(x => /^\d+$/.test(x));
            audit(req, req.method, entity, idPart ? Number(idPart) : null, { path: req.path, status_code: res.statusCode }).catch(() => {});
        }
    });
    next();
});

// =====================================================
// HELPERS
// =====================================================

function money(value) {

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : 0;
}

function cleanString(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    const text =
        String(value).trim();

    return text === ""
        ? null
        : text;
}

function normalizePayrollMonth(value) {

    const month =
        cleanString(value);

    if (!month) {
        return null;
    }

    // YYYY-MM
    if (
        /^\d{4}-\d{2}$/.test(month)
    ) {
        return month + "-01";
    }

    // YYYY-MM-DD
    if (
        /^\d{4}-\d{2}-\d{2}$/.test(month)
    ) {
        return month;
    }

    return month;
}

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {

    res.redirect("/login");

});

// Lightweight health check for troubleshooting the local server.
app.get("/api/health", async (req, res) => {
    try {
        await db.query("SELECT 1");
        return res.json({ success: true, database: true, time: new Date().toISOString() });
    } catch (error) {
        return res.status(503).json({ success: false, database: false, message: "قاعدة البيانات غير متاحة" });
    }
});

// =====================================================
// AUTH - LOGIN
// =====================================================

app.post("/api/auth/login", async (req, res) => {

    try {

        const {
            username,
            password
        } = req.body;

        if (
            !username ||
            !password
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "اسم المستخدم وكلمة المرور مطلوبان"

            });

        }

        const result =
            await auth.login(
                username,
                password
            );

        if (!result.success) {

            return res.status(401).json(
                result
            );

        }

        if (result.token) {
            setAuthCookie(res, result.token);
        }

        return res.json(result);

    } catch (error) {

        console.error(
            "LOGIN ROUTE ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                "حدث خطأ في تسجيل الدخول"

        });

    }

});

// =====================================================
// AUTH - LOGOUT
// =====================================================

app.post("/api/auth/logout", (req, res) => {
    clearAuthCookie(res);
    return res.json({ success: true, message: "تم تسجيل الخروج" });
});

// =====================================================
// AUTH - SESSION / LOGOUT
// =====================================================

app.get('/api/auth/me', async (req, res) => {
    return res.json({ success: true, user: { id: req.user.sub, username: req.user.username, role: req.user.role } });
});

app.post('/api/auth/logout', async (req, res) => {
    clearAuthCookie(res);
    return res.json({ success: true, message: 'تم تسجيل الخروج' });
});

// =====================================================
// AUTH - GET USER
// =====================================================

app.get(
    "/api/auth/user/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم المستخدم غير صحيح"

                });

            }

            const result =
                await auth.getUserById(id);

            if (!result.success) {

                return res.status(404).json(
                    result
                );

            }

            return res.json(result);

        } catch (error) {

            console.error(
                "GET USER ROUTE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب بيانات المستخدم"

            });

        }

    }
);

// =====================================================
// PAGES
// =====================================================

app.get("/login", (req, res) => {

    res.sendFile(
        __dirname + "/login.html"
    );

});

app.get("/dashboard", (req, res) => {

    res.sendFile(
        __dirname + "/dashboard.html"
    );

});

app.get("/employees", (req, res) => {

    res.sendFile(
        __dirname + "/employees.html"
    );

});

app.get("/payroll", (req, res) => {

    res.sendFile(
        __dirname + "/payroll.html"
    );

});

app.get("/attendance", (req, res) => {

    res.sendFile(
        __dirname + "/attendance.html"
    );

});

app.get("/invoices", (req, res) => {

    res.sendFile(
        __dirname + "/invoices.html"
    );

});

app.get("/projects", (req, res) => {

    res.sendFile(
        __dirname + "/projects.html"
    );

});

app.get("/payments", (req, res) => {

    res.sendFile(
        __dirname + "/payments.html"
    );

});

// =====================================================
// MODULES
// =====================================================

const modules = {

    employees: {
        ar: "الموظفين",
        en: "Employees",
        icon: "👥"
    },

    attendance: {
        ar: "الحضور والانصراف",
        en: "Attendance",
        icon: "🕐"
    },

    payroll: {
        ar: "الرواتب",
        en: "Payroll",
        icon: "💰"
    },

    invoices: {
        ar: "الفواتير",
        en: "Invoices",
        icon: "📄"
    },

    payments: {
        ar: "المدفوعات",
        en: "Payments",
        icon: "💳"
    },

    projects: {
        ar: "المشاريع",
        en: "Projects",
        icon: "🏗️"
    },

    reports: {
        ar: "التقارير",
        en: "Reports",
        icon: "📊"
    }

};

// =====================================================
// EMPLOYEE STATISTICS
// =====================================================

app.get(
    "/api/employees/stats/summary",
    async (req, res) => {

        try {

            const [totalRows] =
                await db.query(`

                    SELECT COUNT(*) AS total

                    FROM employees

                `);

            const [activeRows] =
                await db.query(`

                    SELECT COUNT(*) AS total

                    FROM employees

                    WHERE
                        employment_status = 'Active'
                        AND status = 'active'

                `);

            const [inactiveRows] =
                await db.query(`

                    SELECT COUNT(*) AS total

                    FROM employees

                    WHERE
                        employment_status <> 'Active'
                        OR employment_status IS NULL
                        OR status <> 'active'
                        OR status IS NULL

                `);

            const [salaryRows] =
                await db.query(`

                    SELECT

                        COALESCE(
                            SUM(payroll_salary),
                            0
                        ) AS total_salary

                    FROM employees

                    WHERE
                        employment_status = 'Active'
                        AND status = 'active'

                `);

            return res.json({

                success: true,

                total:
                    Number(
                        totalRows[0].total || 0
                    ),

                active:
                    Number(
                        activeRows[0].total || 0
                    ),

                inactive:
                    Number(
                        inactiveRows[0].total || 0
                    ),

                total_salary:
                    money(
                        salaryRows[0].total_salary
                    )

            });

        } catch (error) {

            console.error(
                "EMPLOYEE STATS ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب إحصائيات الموظفين",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// GET ALL EMPLOYEES
// =====================================================

app.get(
    "/api/employees",
    async (req, res) => {

        try {

            const [rows] =
                await db.query(`

                    SELECT *

                    FROM employees

                    ORDER BY id DESC

                `);

            return res.json({

                success: true,

                count:
                    rows.length,

                employees:
                    rows

            });

        } catch (error) {

            console.error(
                "GET EMPLOYEES ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب الموظفين",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// SEARCH EMPLOYEES
// =====================================================

app.get(
    "/api/employees/search/:keyword",
    async (req, res) => {

        try {

            const keyword =
                String(
                    req.params.keyword || ""
                ).trim();

            if (!keyword) {

                return res.status(400).json({

                    success: false,

                    message:
                        "اكتب كلمة البحث"

                });

            }

            const search =
                `%${keyword}%`;

            const [rows] =
                await db.query(`

                    SELECT *

                    FROM employees

                    WHERE

                        full_name LIKE ?
                        OR employee_code LIKE ?
                        OR nationality LIKE ?
                        OR job_title LIKE ?
                        OR department LIKE ?
                        OR company_name LIKE ?
                        OR phone LIKE ?
                        OR email LIKE ?

                    ORDER BY id DESC

                `, [

                    search,
                    search,
                    search,
                    search,
                    search,
                    search,
                    search,
                    search

                ]);

            return res.json({

                success: true,

                count:
                    rows.length,

                employees:
                    rows

            });

        } catch (error) {

            console.error(
                "SEARCH EMPLOYEES ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء البحث عن الموظفين",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// GET EMPLOYEE BY ID
// =====================================================

app.get(
    "/api/employees/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الموظف غير صحيح"

                });

            }

            const [rows] =
                await db.query(`

                    SELECT *

                    FROM employees

                    WHERE id = ?

                `, [id]);

            if (
                rows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            return res.json({

                success: true,

                employee:
                    rows[0]

            });

        } catch (error) {

            console.error(
                "GET EMPLOYEE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب بيانات الموظف",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// CREATE EMPLOYEE
// =====================================================

app.post(
    "/api/employees",
    async (req, res) => {

        try {

            const {

                employee_code,
                full_name,
                nationality,
                job_title,
                birth_date,
                gender,
                marital_status,
                id_number,
                id_issue_date,
                id_expiry_date,
                phone_country_code,
                department,
                company_name,
                hire_date,
                phone,
                email,
                basic_salary,
                payroll_salary,
                joining_date,
                contract_end_date,
                project_id,
                employment_status,
                notes,
                housing_allowance,
                transport_allowance,
                other_allowance,
                status

            } = req.body;

            if (
                !full_name ||
                !String(full_name).trim()
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "اسم الموظف مطلوب"

                });

            }

            const [result] =
                await db.query(`

                    INSERT INTO employees
                    (

                        employee_code,
                        full_name,
                        nationality,
                        job_title,
                        birth_date,
                        gender,
                        marital_status,
                        id_number,
                        id_issue_date,
                        id_expiry_date,
                        phone_country_code,
                        company_name,
                        hire_date,
                        phone,
                        email,
                        basic_salary,
                        payroll_salary,
                        joining_date,
                        contract_end_date,
                        project_id,
                        employment_status,
                        notes,
                        housing_allowance,
                        transport_allowance,
                        other_allowance,
                        status

                    )

                    VALUES
                    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)

                `, [

                    cleanString(employee_code),
                    String(full_name).trim(),
                    cleanString(nationality),
                    cleanString(job_title),
                    birth_date || null,
                    cleanString(gender),
                    cleanString(marital_status),
                    cleanString(id_number),
                    id_issue_date || null,
                    id_expiry_date || null,
                    cleanString(phone_country_code).replace(/[^0-9+]/g, "").slice(0, 10),
                    cleanString(company_name),
                    hire_date || null,
                    cleanString(phone),
                    cleanString(email),
                    money(basic_salary),
                    money(payroll_salary),
                    joining_date || null,
                    contract_end_date || null,
                    project_id || null,
                    employment_status || "Active",
                    cleanString(notes),
                    money(housing_allowance),
                    money(transport_allowance),
                    money(other_allowance),
                    status || "active"

                ]);

            return res.status(201).json({

                success: true,

                message:
                    "تم إضافة الموظف بنجاح",

                employee_id:
                    result.insertId

            });

        } catch (error) {

            console.error(
                "CREATE EMPLOYEE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء إضافة الموظف",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// UPDATE EMPLOYEE
// =====================================================

app.put(
    "/api/employees/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الموظف غير صحيح"

                });

            }

            const {

                employee_code,
                full_name,
                nationality,
                job_title,
                birth_date,
                gender,
                marital_status,
                id_number,
                id_issue_date,
                id_expiry_date,
                phone_country_code,
                department,
                company_name,
                hire_date,
                phone,
                email,
                basic_salary,
                payroll_salary,
                joining_date,
                contract_end_date,
                project_id,
                employment_status,
                notes,
                housing_allowance,
                transport_allowance,
                other_allowance,
                status

            } = req.body;

            if (
                !full_name ||
                !String(full_name).trim()
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "اسم الموظف مطلوب"

                });

            }

            const [result] =
                await db.query(`

                    UPDATE employees

                    SET

                        employee_code = ?,
                        full_name = ?,
                        nationality = ?,
                        job_title = ?,
                        birth_date = ?,
                        gender = ?,
                        marital_status = ?,
                        id_number = ?,
                        id_issue_date = ?,
                        id_expiry_date = ?,
                        phone_country_code = ?,
                        company_name = ?,
                        hire_date = ?,
                        phone = ?,
                        email = ?,
                        basic_salary = ?,
                        payroll_salary = ?,
                        joining_date = ?,
                        contract_end_date = ?,
                        project_id = ?,
                        employment_status = ?,
                        notes = ?,
                        housing_allowance = ?,
                        transport_allowance = ?,
                        other_allowance = ?,
                        status = ?

                    WHERE id = ?

                `, [

                    cleanString(employee_code),
                    String(full_name).trim(),
                    cleanString(nationality),
                    cleanString(job_title),
                    birth_date || null,
                    cleanString(gender),
                    cleanString(marital_status),
                    cleanString(id_number),
                    id_issue_date || null,
                    id_expiry_date || null,
                    cleanString(phone_country_code).replace(/[^0-9+]/g, "").slice(0, 10),
                    cleanString(company_name),
                    hire_date || null,
                    cleanString(phone),
                    cleanString(email),
                    money(basic_salary),
                    money(payroll_salary),
                    joining_date || null,
                    contract_end_date || null,
                    project_id || null,
                    employment_status || "Active",
                    cleanString(notes),
                    money(housing_allowance),
                    money(transport_allowance),
                    money(other_allowance),
                    status || "active",
                    id

                ]);

            if (
                result.affectedRows === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم تعديل بيانات الموظف بنجاح"

            });

        } catch (error) {

            console.error(
                "UPDATE EMPLOYEE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء تعديل الموظف",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// DELETE EMPLOYEE
// =====================================================

app.delete(
    "/api/employees/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الموظف غير صحيح"

                });

            }

            const [result] =
                await db.query(`

                    DELETE FROM employees

                    WHERE id = ?

                `, [id]);

            if (
                result.affectedRows === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم حذف الموظف بنجاح"

            });

        } catch (error) {

            console.error(
                "DELETE EMPLOYEE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "لا يمكن حذف الموظف",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// PAYROLL API
// =====================================================

// =====================================================
// GET ACTIVE EMPLOYEES FOR PAYROLL
// =====================================================

app.get(
    "/api/payroll/employees",
    async (req, res) => {

        try {

            const [rows] =
                await db.query(`

                    SELECT

                        id,
                        employee_code,
                        full_name,
                        job_title,
                        department,
                        company_name,

                        basic_salary,
                        payroll_salary,

                        housing_allowance,
                        transport_allowance,
                        other_allowance,

                        employment_status,
                        status

                    FROM employees

                    WHERE

                        employment_status = 'Active'

                        AND status = 'active'

                    ORDER BY full_name ASC

                `);

            return res.json({

                success: true,

                count:
                    rows.length,

                employees:
                    rows.map(
                        employee => ({

                            ...employee,

                            basic_salary:
                                money(
                                    employee.basic_salary
                                ),

                            payroll_salary:
                                money(
                                    employee.payroll_salary
                                ),

                            housing_allowance:
                                money(
                                    employee.housing_allowance
                                ),

                            transport_allowance:
                                money(
                                    employee.transport_allowance
                                ),

                            other_allowance:
                                money(
                                    employee.other_allowance
                                )

                        })
                    )

            });

        } catch (error) {

            console.error(
                "GET PAYROLL EMPLOYEES ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب موظفي الرواتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// PAYROLL ATTENDANCE SUMMARY
// =====================================================

app.get(
    "/api/payroll/attendance-summary",
    async (req, res) => {

        try {

            const employeeId =
                Number(
                    req.query.employee_id
                );

            const payrollMonth =
                normalizePayrollMonth(
                    req.query.month
                );

            if (!employeeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الموظف مطلوب"

                });

            }

            if (!payrollMonth) {

                return res.status(400).json({

                    success: false,

                    message:
                        "شهر الراتب مطلوب"

                });

            }

            const [employeeRows] =
                await db.query(`

                    SELECT

                        id,
                        full_name,
                        payroll_salary

                    FROM employees

                    WHERE id = ?

                    LIMIT 1

                `, [employeeId]);

            if (
                employeeRows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            const employee =
                employeeRows[0];

            const [rows] =
                await db.query(`

                    SELECT

                        COUNT(*) AS total_records,

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
                        ) AS late_days,

                        SUM(
                            CASE
                                WHEN status = 'Leave'
                                THEN 1
                                ELSE 0
                            END
                        ) AS leave_days,

                        SUM(
                            CASE
                                WHEN status = 'Off'
                                THEN 1
                                ELSE 0
                            END
                        ) AS off_days

                    FROM attendance_records

                    WHERE

                        employee_id = ?

                        AND DATE_FORMAT(
                            attendance_date,
                            '%Y-%m'
                        ) = DATE_FORMAT(
                            ?,
                            '%Y-%m'
                        )

                `, [

                    employeeId,
                    payrollMonth

                ]);

            const summary =
                rows[0] || {};

            const workingDays = 30;

            const presentDays =
                Number(
                    summary.present_days || 0
                );

            const absentDays =
                Number(
                    summary.absent_days || 0
                );

            const lateDays =
                Number(
                    summary.late_days || 0
                );

            const leaveDays =
                Number(
                    summary.leave_days || 0
                );

            const offDays =
                Number(
                    summary.off_days || 0
                );

            const salary =
                money(
                    employee.payroll_salary
                );

            const dailySalary =
                workingDays > 0
                    ? salary / workingDays
                    : 0;

            const absenceDeduction =
                absentDays * dailySalary;

            return res.json({

                success: true,

                employee_id:
                    employeeId,

                employee_name:
                    employee.full_name,

                month:
                    payrollMonth,

                payroll_salary:
                    Number(
                        salary.toFixed(2)
                    ),

                working_days:
                    workingDays,

                present_days:
                    presentDays,

                absent_days:
                    absentDays,

                late_days:
                    lateDays,

                leave_days:
                    leaveDays,

                off_days:
                    offDays,

                daily_salary:
                    Number(
                        dailySalary.toFixed(2)
                    ),

                absence_deduction:
                    Number(
                        absenceDeduction.toFixed(2)
                    )

            });

        } catch (error) {

            console.error(
                "PAYROLL ATTENDANCE SUMMARY ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء حساب حضور الموظف للراتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// PAYROLL MONTH ARCHIVE
// =====================================================
app.get("/api/payroll/months", async (req,res)=>{
    try {
        const [rows]=await db.query(`
            SELECT DISTINCT DATE_FORMAT(payroll_month,'%Y-%m') AS month
            FROM payroll_records
            WHERE payroll_month IS NOT NULL
            ORDER BY month DESC
        `);
        return res.json({success:true,months:rows.map(r=>r.month).filter(Boolean)});
    } catch(error) {
        console.error("PAYROLL MONTHS ERROR:",error);
        return res.status(500).json({success:false,message:"تعذر تحميل الشهور السابقة",error:error.message});
    }
});

// =====================================================
// GET PAYROLL RECORDS
// =====================================================

app.get(
    "/api/payroll",
    async (req, res) => {

        try {

            const payrollMonth =
                normalizePayrollMonth(
                    req.query.month
                );

            let sql = `

                SELECT

                    pr.*,

                    e.employee_code,
                    e.full_name,
                    e.job_title,
                    e.department,

                    e.payroll_salary
                        AS employee_payroll_salary

                FROM payroll_records pr

                INNER JOIN employees e

                    ON e.id =
                       pr.employee_id

            `;

            const params = [];

            if (payrollMonth) {

                sql += `

                    WHERE
                        pr.payroll_month = ?

                `;

                params.push(
                    payrollMonth
                );

            }

            sql += `

                ORDER BY pr.id DESC

            `;

            const [rows] =
                await db.query(
                    sql,
                    params
                );

            return res.json({

                success: true,

                count:
                    rows.length,

                records:
                    rows

            });

        } catch (error) {

            console.error(
                "GET PAYROLL ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب الرواتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// GET PAYROLL BY ID
// =====================================================

app.get(
    "/api/payroll/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم كشف الراتب غير صحيح"

                });

            }

            const [rows] =
                await db.query(`

                    SELECT

                        pr.*,

                        e.employee_code,
                        e.full_name,
                        e.job_title,
                        e.department

                    FROM payroll_records pr

                    INNER JOIN employees e

                        ON e.id =
                           pr.employee_id

                    WHERE
                        pr.id = ?

                    LIMIT 1

                `, [id]);

            if (
                rows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "كشف الراتب غير موجود"

                });

            }

            return res.json({

                success: true,

                record:
                    rows[0]

            });

        } catch (error) {

            console.error(
                "GET PAYROLL BY ID ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب كشف الراتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// CREATE PAYROLL
// =====================================================

app.post(
    "/api/payroll",
    async (req, res) => {

        try {

            const {

                employee_id,
                payroll_month,
                working_days,
                absent_days,
                absence_deduction,
                additions,
                deductions,
                overtime_amount,
                overtime_hours,
                notes

            } = req.body;

            const employeeId =
                Number(employee_id);

            const databaseMonth =
                normalizePayrollMonth(
                    payroll_month
                );

            if (!employeeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "الموظف مطلوب"

                });

            }

            if (!databaseMonth) {

                return res.status(400).json({

                    success: false,

                    message:
                        "شهر الراتب مطلوب"

                });

            }

            // =================================================
            // GET EMPLOYEE
            // =================================================

            const [employeeRows] =
                await db.query(`

                    SELECT

                        id,
                        full_name,
                        payroll_salary,
                        employment_status,
                        status

                    FROM employees

                    WHERE id = ?

                    LIMIT 1

                `, [employeeId]);

            if (
                employeeRows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            const employee =
                employeeRows[0];

            // =================================================
            // SALARY
            // =================================================

            const salary =
                money(
                    employee.payroll_salary
                );

            // =================================================
            // WORKING DAYS
            // =================================================

            let workingDays =
                Number(
                    working_days
                );

            if (
                !Number.isFinite(
                    workingDays
                ) ||
                workingDays < 1
            ) {

                workingDays = 30;

            }

            if (
                workingDays > 31
            ) {

                workingDays = 31;

            }

            // =================================================
            // GET ATTENDANCE
            // =================================================

            const [attendanceRows] =
                await db.query(`

                    SELECT

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
                        ) AS late_days,

                        SUM(
                            CASE
                                WHEN status = 'Leave'
                                THEN 1
                                ELSE 0
                            END
                        ) AS leave_days,

                        SUM(
                            CASE
                                WHEN status = 'Off'
                                THEN 1
                                ELSE 0
                            END
                        ) AS off_days

                    FROM attendance_records

                    WHERE

                        employee_id = ?

                        AND DATE_FORMAT(
                            attendance_date,
                            '%Y-%m'
                        ) = DATE_FORMAT(
                            ?,
                            '%Y-%m'
                        )

                `, [

                    employeeId,
                    databaseMonth

                ]);

            const attendance =
                attendanceRows[0] || {};

            const presentDays =
                Number(
                    attendance.present_days || 0
                );

            const absentDaysFromAttendance =
                Number(
                    attendance.absent_days || 0
                );

            const lateDays =
                Number(
                    attendance.late_days || 0
                );

            const leaveDays =
                Number(
                    attendance.leave_days || 0
                );

            const offDays =
                Number(
                    attendance.off_days || 0
                );

            // =================================================
            // ABSENT DAYS
            // =================================================

            let finalAbsentDays =
                absentDaysFromAttendance;

            // لو مفيش Attendance Records
            // نستخدم القيمة القادمة من الواجهة

            if (
                Number.isFinite(
                    Number(absent_days)
                ) &&
                absentDaysFromAttendance === 0
            ) {

                finalAbsentDays =
                    Math.max(
                        0,
                        Number(absent_days)
                    );

            }

            // =================================================
            // DAILY SALARY
            // =================================================

            const dailySalary =
                workingDays > 0
                    ? salary / workingDays
                    : 0;

            // =================================================
            // ABSENCE DEDUCTION
            // =================================================

            const calculatedAbsenceDeduction =
                finalAbsentDays *
                dailySalary;

            // القيمة المحسوبة من السيرفر هي المعتمدة
            const finalAbsenceDeduction =
                Number(
                    calculatedAbsenceDeduction.toFixed(2)
                );

            // =================================================
            // OTHER AMOUNTS
            // =================================================

            const additionsAmount =
                money(
                    additions
                );

            const deductionsAmount =
                money(
                    deductions
                );

            let overtimeHours =
                Number(overtime_hours);

            if (!Number.isFinite(overtimeHours) || overtimeHours < 0) {
                overtimeHours = 0;
            }

            let overtimeAmount =
                money(overtime_amount);

            if (overtime_hours !== undefined && overtime_hours !== null && overtime_hours !== "") {
                const hourlyRate = dailySalary / 8;
                overtimeAmount = Number((overtimeHours * hourlyRate).toFixed(2));
            }

            // =================================================
            // NET SALARY
            // =================================================

            const netSalary =
                Math.max(
                    0,
                    salary
                    + overtimeAmount
                    + additionsAmount
                    - finalAbsenceDeduction
                    - deductionsAmount
                );

            // =================================================
            // CHECK EXISTING
            // =================================================

            const [existingRows] =
                await db.query(`

                    SELECT id

                    FROM payroll_records

                    WHERE

                        employee_id = ?

                        AND payroll_month = ?

                    LIMIT 1

                `, [

                    employeeId,
                    databaseMonth

                ]);

            // =================================================
            // IF EXISTS -> UPDATE
            // =================================================

            if (
                existingRows.length > 0
            ) {

                const recordId =
                    existingRows[0].id;

                await db.query(`

                    UPDATE payroll_records

                    SET

                        payroll_salary = ?,
                        working_days = ?,
                        absent_days = ?,
                        absence_deduction = ?,
                        additions = ?,
                        deductions = ?,
                        overtime_amount = ?,
                        overtime_hours = ?,
                        net_salary = ?,
                        notes = ?,
                        status = 'draft'

                    WHERE id = ?

                `, [

                    salary,
                    workingDays,
                    finalAbsentDays,
                    finalAbsenceDeduction,
                    additionsAmount,
                    deductionsAmount,
                    overtimeAmount,
                    overtimeHours,
                    netSalary,
                    cleanString(notes),
                    recordId

                ]);

                return res.json({

                    success: true,

                    message:
                        "تم تحديث كشف الراتب وحساب الغياب تلقائيًا",

                    record_id:
                        recordId,

                    payroll_salary:
                        Number(
                            salary.toFixed(2)
                        ),

                    working_days:
                        workingDays,

                    present_days:
                        presentDays,

                    absent_days:
                        finalAbsentDays,

                    late_days:
                        lateDays,

                    leave_days:
                        leaveDays,

                    off_days:
                        offDays,

                    daily_salary:
                        Number(
                            dailySalary.toFixed(2)
                        ),

                    absence_deduction:
                        finalAbsenceDeduction,

                    overtime_amount:
                        Number(
                            overtimeAmount.toFixed(2)
                        ),

                    overtime_hours:
                        Number(
                            overtimeHours.toFixed(2)
                        ),

                    additions:
                        Number(
                            additionsAmount.toFixed(2)
                        ),

                    deductions:
                        Number(
                            deductionsAmount.toFixed(2)
                        ),

                    net_salary:
                        Number(
                            netSalary.toFixed(2)
                        )

                });

            }

            // =================================================
            // CREATE
            // =================================================

            const [result] =
                await db.query(`

                    INSERT INTO payroll_records
                    (

                        employee_id,
                        payroll_month,
                        payroll_salary,
                        working_days,
                        absent_days,
                        absence_deduction,
                        additions,
                        deductions,
                        overtime_amount,
                        overtime_hours,
                        net_salary,
                        status,
                        notes

                    )

                    VALUES
                    (

                        ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, 'draft', ?

                    )

                `, [

                    employeeId,
                    databaseMonth,
                    salary,
                    workingDays,
                    finalAbsentDays,
                    finalAbsenceDeduction,
                    additionsAmount,
                    deductionsAmount,
                    overtimeAmount,
                    overtimeHours,
                    netSalary,
                    cleanString(notes)

                ]);

            return res.status(201).json({

                success: true,

                message:
                    "تم إنشاء كشف الراتب وحساب الغياب تلقائيًا",

                record_id:
                    result.insertId,

                payroll_salary:
                    Number(
                        salary.toFixed(2)
                    ),

                working_days:
                    workingDays,

                present_days:
                    presentDays,

                absent_days:
                    finalAbsentDays,

                late_days:
                    lateDays,

                leave_days:
                    leaveDays,

                off_days:
                    offDays,

                daily_salary:
                    Number(
                        dailySalary.toFixed(2)
                    ),

                absence_deduction:
                    finalAbsenceDeduction,

                overtime_amount:
                    Number(
                        overtimeAmount.toFixed(2)
                    ),

                additions:
                    Number(
                        additionsAmount.toFixed(2)
                    ),

                deductions:
                    Number(
                        deductionsAmount.toFixed(2)
                    ),

                net_salary:
                    Number(
                        netSalary.toFixed(2)
                    )

            });

        } catch (error) {

            console.error(
                "CREATE PAYROLL ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء إنشاء كشف الراتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// UPDATE PAYROLL
// =====================================================

app.put(
    "/api/payroll/:id",
    async (req, res) => {

        try {

            const recordId =
                Number(req.params.id);

            if (!recordId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم كشف الراتب غير صحيح"

                });

            }

            const {

                employee_id,
                payroll_month,
                working_days,
                absent_days,
                additions,
                deductions,
                overtime_amount,
                overtime_hours,
                notes

            } = req.body;

            const employeeId =
                Number(employee_id);

            const databaseMonth =
                normalizePayrollMonth(
                    payroll_month
                );

            if (!employeeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "الموظف مطلوب"

                });

            }

            if (!databaseMonth) {

                return res.status(400).json({

                    success: false,

                    message:
                        "شهر الراتب مطلوب"

                });

            }

            // =================================================
            // CHECK RECORD
            // =================================================

            const [recordRows] =
                await db.query(`

                    SELECT id

                    FROM payroll_records

                    WHERE id = ?

                    LIMIT 1

                `, [recordId]);

            if (
                recordRows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "كشف الراتب غير موجود"

                });

            }

            // =================================================
            // CHECK EMPLOYEE
            // =================================================

            const [employeeRows] =
                await db.query(`

                    SELECT

                        id,
                        full_name,
                        payroll_salary,
                        employment_status,
                        status

                    FROM employees

                    WHERE id = ?

                    LIMIT 1

                `, [employeeId]);

            if (
                employeeRows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            const employee =
                employeeRows[0];

            // =================================================
            // CHECK DUPLICATE
            // =================================================

            const [duplicateRows] =
                await db.query(`

                    SELECT id

                    FROM payroll_records

                    WHERE

                        employee_id = ?

                        AND payroll_month = ?

                        AND id <> ?

                    LIMIT 1

                `, [

                    employeeId,
                    databaseMonth,
                    recordId

                ]);

            if (
                duplicateRows.length > 0
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        "يوجد بالفعل كشف راتب لهذا الموظف في نفس الشهر"

                });

            }

            // =================================================
            // SALARY
            // =================================================

            const salary =
                money(
                    employee.payroll_salary
                );

            // =================================================
            // WORKING DAYS
            // =================================================

            let workingDays =
                Number(
                    working_days
                );

            if (
                !Number.isFinite(
                    workingDays
                ) ||
                workingDays < 1
            ) {

                workingDays = 30;

            }

            if (
                workingDays > 31
            ) {

                workingDays = 31;

            }

            // =================================================
            // ATTENDANCE
            // =================================================

            const [attendanceRows] =
                await db.query(`

                    SELECT

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
                        ) AS late_days,

                        SUM(
                            CASE
                                WHEN status = 'Leave'
                                THEN 1
                                ELSE 0
                            END
                        ) AS leave_days,

                        SUM(
                            CASE
                                WHEN status = 'Off'
                                THEN 1
                                ELSE 0
                            END
                        ) AS off_days

                    FROM attendance_records

                    WHERE

                        employee_id = ?

                        AND DATE_FORMAT(
                            attendance_date,
                            '%Y-%m'
                        ) = DATE_FORMAT(
                            ?,
                            '%Y-%m'
                        )

                `, [

                    employeeId,
                    databaseMonth

                ]);

            const attendance =
                attendanceRows[0] || {};

            const presentDays =
                Number(
                    attendance.present_days || 0
                );

            const attendanceAbsentDays =
                Number(
                    attendance.absent_days || 0
                );

            const lateDays =
                Number(
                    attendance.late_days || 0
                );

            const leaveDays =
                Number(
                    attendance.leave_days || 0
                );

            const offDays =
                Number(
                    attendance.off_days || 0
                );

            // =================================================
            // ABSENT DAYS
            // =================================================

            let finalAbsentDays =
                attendanceAbsentDays;

            if (
                attendanceAbsentDays === 0 &&
                Number.isFinite(
                    Number(absent_days)
                )
            ) {

                finalAbsentDays =
                    Math.max(
                        0,
                        Number(absent_days)
                    );

            }

            // =================================================
            // DAILY SALARY
            // =================================================

            const dailySalary =
                workingDays > 0
                    ? salary / workingDays
                    : 0;

            // =================================================
            // ABSENCE DEDUCTION
            // =================================================

            const absenceDeduction =
                Number(
                    (
                        finalAbsentDays *
                        dailySalary
                    ).toFixed(2)
                );

            // =================================================
            // OTHER AMOUNTS
            // =================================================

            const additionsAmount =
                money(
                    additions
                );

            const deductionsAmount =
                money(
                    deductions
                );

            let overtimeHours =
                Number(overtime_hours);

            if (!Number.isFinite(overtimeHours) || overtimeHours < 0) {
                overtimeHours = 0;
            }

            let overtimeAmount =
                money(overtime_amount);

            if (overtime_hours !== undefined && overtime_hours !== null && overtime_hours !== "") {
                const hourlyRate = dailySalary / 8;
                overtimeAmount = Number((overtimeHours * hourlyRate).toFixed(2));
            }

            // =================================================
            // NET
            // =================================================

            const netSalary =
                Math.max(
                    0,
                    salary
                    + overtimeAmount
                    + additionsAmount
                    - absenceDeduction
                    - deductionsAmount
                );

            // =================================================
            // UPDATE
            // =================================================

            await db.query(`

                UPDATE payroll_records

                SET

                    employee_id = ?,
                    payroll_month = ?,
                    payroll_salary = ?,
                    working_days = ?,
                    absent_days = ?,
                    absence_deduction = ?,
                    additions = ?,
                    deductions = ?,
                    overtime_amount = ?,
                    net_salary = ?,
                    notes = ?,
                    status = 'draft'

                WHERE id = ?

            `, [

                employeeId,
                databaseMonth,
                salary,
                workingDays,
                finalAbsentDays,
                absenceDeduction,
                additionsAmount,
                deductionsAmount,
                overtimeAmount,
                netSalary,
                cleanString(notes),
                recordId

            ]);

            return res.json({

                success: true,

                message:
                    "تم تحديث كشف الراتب بنجاح",

                record_id:
                    recordId,

                payroll_salary:
                    Number(
                        salary.toFixed(2)
                    ),

                working_days:
                    workingDays,

                present_days:
                    presentDays,

                absent_days:
                    finalAbsentDays,

                late_days:
                    lateDays,

                leave_days:
                    leaveDays,

                off_days:
                    offDays,

                daily_salary:
                    Number(
                        dailySalary.toFixed(2)
                    ),

                absence_deduction:
                    absenceDeduction,

                overtime_amount:
                    Number(
                        overtimeAmount.toFixed(2)
                    ),

                additions:
                    Number(
                        additionsAmount.toFixed(2)
                    ),

                deductions:
                    Number(
                        deductionsAmount.toFixed(2)
                    ),

                net_salary:
                    Number(
                        netSalary.toFixed(2)
                    )

            });

        } catch (error) {

            console.error(
                "UPDATE PAYROLL ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء تحديث كشف الراتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// DELETE PAYROLL
// =====================================================

app.delete(
    "/api/payroll/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم كشف الراتب غير صحيح"

                });

            }

            const [result] =
                await db.query(`

                    DELETE FROM payroll_records

                    WHERE id = ?

                `, [id]);

            if (
                result.affectedRows === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "كشف الراتب غير موجود"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم حذف كشف الراتب بنجاح"

            });

        } catch (error) {

            console.error(
                "DELETE PAYROLL ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء حذف كشف الراتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// PAYROLL SUMMARY
// =====================================================

app.get(
    "/api/payroll/stats/summary",
    async (req, res) => {

        try {

            const payrollMonth =
                normalizePayrollMonth(
                    req.query.month
                );

            if (!payrollMonth) {

                return res.status(400).json({

                    success: false,

                    message:
                        "يجب تحديد شهر الرواتب"

                });

            }

            const [rows] =
                await db.query(`

                    SELECT

                        COUNT(*) AS total_records,

                        COALESCE(
                            SUM(payroll_salary),
                            0
                        ) AS total_payroll_salary,

                        COALESCE(
                            SUM(overtime_amount),
                            0
                        ) AS total_overtime,

                        COALESCE(
                            SUM(additions),
                            0
                        ) AS total_additions,

                        COALESCE(
                            SUM(absence_deduction),
                            0
                        ) AS total_absence_deduction,

                        COALESCE(
                            SUM(deductions),
                            0
                        ) AS total_deductions,

                        COALESCE(
                            SUM(net_salary),
                            0
                        ) AS total_net_salary

                    FROM payroll_records

                    WHERE
                        payroll_month = ?

                `, [payrollMonth]);

            const summary =
                rows[0] || {};

            return res.json({

                success: true,

                month:
                    payrollMonth,

                total_records:
                    Number(
                        summary.total_records || 0
                    ),

                total_payroll_salary:
                    money(
                        summary.total_payroll_salary
                    ),

                total_overtime:
                    money(
                        summary.total_overtime
                    ),

                total_additions:
                    money(
                        summary.total_additions
                    ),

                total_absence_deduction:
                    money(
                        summary.total_absence_deduction
                    ),

                total_deductions:
                    money(
                        summary.total_deductions
                    ),

                total_net_salary:
                    money(
                        summary.total_net_salary
                    )

            });

        } catch (error) {

            console.error(
                "PAYROLL SUMMARY ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب ملخص الرواتب",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// PROJECT EXPENSES / PROFITABILITY API
// =====================================================
app.get('/api/projects/:id/expenses', requirePermission('projects.view'), async (req,res)=>{
    try {
        const id=Number(req.params.id);
        if(!id) return res.status(400).json({success:false,message:'رقم المشروع غير صحيح'});
        const [rows]=await db.query(`SELECT id, project_id, expense_date, category, description, amount, reference_number, notes, created_at FROM project_expenses WHERE project_id=? ORDER BY expense_date DESC,id DESC`,[id]);
        return res.json({success:true,expenses:rows.map(r=>({...r,amount:money(r.amount)}))});
    } catch(e){ return res.status(500).json({success:false,message:'حدث خطأ أثناء جلب مصروفات المشروع',error:e.message}); }
});
app.post('/api/projects/:id/expenses', requirePermission('projects.write'), async (req,res)=>{
    try {
        const projectId=Number(req.params.id);
        const [projectRows]=await db.query('SELECT id FROM projects WHERE id=? LIMIT 1',[projectId]);
        if(!projectRows.length) return res.status(404).json({success:false,message:'المشروع غير موجود'});
        const expenseDate=cleanString(req.body.expense_date) || new Date().toISOString().slice(0,10);
        const category=cleanString(req.body.category) || 'General';
        const description=cleanString(req.body.description);
        const amount=money(req.body.amount);
        const referenceNumber=cleanString(req.body.reference_number);
        const notes=cleanString(req.body.notes);
        if(amount<=0) return res.status(400).json({success:false,message:'قيمة المصروف يجب أن تكون أكبر من صفر'});
        const [r]=await db.query(`INSERT INTO project_expenses(project_id,expense_date,category,description,amount,reference_number,notes) VALUES(?,?,?,?,?,?,?)`,[projectId,expenseDate,category,description,amount,referenceNumber,notes]);
        await audit(req,'CREATE','project_expenses',r.insertId,{project_id:projectId,amount,category});
        return res.status(201).json({success:true,message:'تم تسجيل تكلفة المشروع',expense_id:r.insertId});
    } catch(e){ return res.status(500).json({success:false,message:'حدث خطأ أثناء تسجيل التكلفة',error:e.message}); }
});
app.delete('/api/projects/expenses/:expenseId', requirePermission('projects.write'), async (req,res)=>{
    try { const id=Number(req.params.expenseId); if(!id) return res.status(400).json({success:false,message:'رقم المصروف غير صحيح'}); const [r]=await db.query('DELETE FROM project_expenses WHERE id=?',[id]); if(!r.affectedRows)return res.status(404).json({success:false,message:'المصروف غير موجود'}); await audit(req,'DELETE','project_expenses',id,{}); return res.json({success:true,message:'تم حذف التكلفة'}); }
    catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء حذف التكلفة',error:e.message});}
});

// =====================================================
// PROJECTS API
// =====================================================

app.get("/api/projects", async (req, res) => {
    try {
        const search = cleanString(req.query.search);
        const status = cleanString(req.query.status);
        let sql = `
            SELECT
                p.id,
                p.project_name,
                p.client_name,
                p.contract_number,
                p.contract_value,
                p.start_date,
                p.end_date,
                p.status,
                p.progress_percentage,
                p.notes,
                p.created_at,
                CASE
                    WHEN COALESCE(p.contract_value, 0) > 0 THEN
                        LEAST(
                            (
                                COALESCE((
                                    SELECT SUM(pay.amount)
                                    FROM payments pay
                                    WHERE pay.project_id = p.id
                                      AND pay.status = 'Paid'
                                ), 0) / p.contract_value
                            ) * 100,
                            100
                        )
                    ELSE 0
                END AS paid_percentage,
                COALESCE((SELECT SUM(pe.amount) FROM project_expenses pe WHERE pe.project_id = p.id), 0) AS total_expenses,
                COALESCE((SELECT SUM(i.total_amount) FROM invoices i WHERE i.project_id = p.id), 0) AS invoiced_total,
                COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.project_id = p.id AND pay.status = 'Paid'), 0) AS collected_total,
                (COALESCE(p.contract_value,0) - COALESCE((SELECT SUM(pe.amount) FROM project_expenses pe WHERE pe.project_id = p.id),0)) AS gross_profit,
                CASE WHEN COALESCE(p.contract_value,0) > 0 THEN
                    ((COALESCE(p.contract_value,0) - COALESCE((SELECT SUM(pe.amount) FROM project_expenses pe WHERE pe.project_id = p.id),0)) / p.contract_value) * 100
                ELSE 0 END AS gross_margin_percentage
            FROM projects p`
        const conditions = [];
        const params = [];
        if (search) {
            const keyword = `%${search}%`;
            conditions.push(`(project_name LIKE ? OR client_name LIKE ? OR contract_number LIKE ?)`);
            params.push(keyword, keyword, keyword);
        }
        if (status) {
            conditions.push("status = ?");
            params.push(status);
        }
        if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
        sql += " ORDER BY id DESC";
        const [rows] = await db.query(sql, params);
        return res.json({ success: true, count: rows.length, projects: rows });
    } catch (error) {
        console.error("GET PROJECTS ERROR:", error);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء جلب المشاريع", error: error.message });
    }
});

app.get("/api/projects/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "رقم المشروع غير صحيح" });
        const [rows] = await db.query(`SELECT id, project_name, client_name, contract_number, contract_value, start_date, end_date, status, progress_percentage, notes, created_at, COALESCE((SELECT SUM(pe.amount) FROM project_expenses pe WHERE pe.project_id = projects.id),0) AS total_expenses FROM projects WHERE id = ? LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, message: "المشروع غير موجود" });
        return res.json({ success: true, project: rows[0] });
    } catch (error) {
        console.error("GET PROJECT ERROR:", error);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء جلب المشروع", error: error.message });
    }
});


// PROJECT DETAIL / FINANCIAL SUMMARY
app.get("/api/projects/:id/summary", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: "رقم المشروع غير صحيح"
            });
        }

        const [projectRows] = await db.query(`
            SELECT
                id, project_name, client_name, contract_number,
                contract_value, start_date, end_date, status, progress_percentage, notes, created_at,
                COALESCE((SELECT SUM(pe.amount) FROM project_expenses pe WHERE pe.project_id = projects.id),0) AS total_expenses
            FROM projects
            WHERE id = ?
            LIMIT 1
        `, [id]);

        if (!projectRows.length) {
            return res.status(404).json({
                success: false,
                message: "المشروع غير موجود"
            });
        }

        const project = projectRows[0];

        const [invoiceRows] = await db.query(`
            SELECT
                i.id,
                i.invoice_number,
                i.invoice_date,
                i.invoice_amount,
                i.vat_amount,
                i.total_amount,
                i.status,
                COALESCE((
                    SELECT SUM(pay.amount)
                    FROM payments pay
                    WHERE pay.invoice_id = i.id
                      AND pay.status = 'Paid'
                ), 0) AS paid_amount
            FROM invoices i
            WHERE i.project_id = ?
            ORDER BY i.invoice_date DESC, i.id DESC
        `, [id]);

        const [paymentRows] = await db.query(`
            SELECT
                pay.id,
                pay.payment_number,
                pay.payment_type,
                pay.amount,
                pay.period_from,
                pay.period_to,
                pay.submitted_date,
                pay.approved_date,
                pay.due_date,
                pay.received_date,
                pay.status,
                pay.invoice_id,
                i.invoice_number
            FROM payments pay
            LEFT JOIN invoices i ON i.id = pay.invoice_id
            WHERE pay.project_id = ?
            ORDER BY pay.id DESC
        `, [id]);

        const invoiceTotal = invoiceRows.reduce(
            (sum, row) => sum + money(row.total_amount), 0
        );
        const invoicePaid = invoiceRows.reduce(
            (sum, row) => sum + money(row.paid_amount), 0
        );
        const paymentRegistered = paymentRows
            .filter(row => row.status !== 'Rejected')
            .reduce((sum, row) => sum + money(row.amount), 0);
        const paymentPaid = paymentRows
            .filter(row => row.status === 'Paid')
            .reduce((sum, row) => sum + money(row.amount), 0);
        const contractValue = money(project.contract_value);
        const paidPercentage = contractValue > 0
            ? Math.min((paymentPaid / contractValue) * 100, 100)
            : 0;
        const invoiceOutstanding = Math.max(invoiceTotal - invoicePaid, 0);
        const today = new Date().toISOString().slice(0, 10);
        const overduePayments = paymentRows.filter(row =>
            row.status !== 'Paid' &&
            row.status !== 'Rejected' &&
            row.due_date &&
            String(row.due_date).slice(0, 10) < today
        ).length;
        const latestPayment = paymentRows[0] || null;
        const latestInvoice = invoiceRows[0] || null;
        const [expenseRows] = await db.query(`
            SELECT id, project_id, expense_date, category, description, amount, reference_number, notes, created_at
            FROM project_expenses
            WHERE project_id = ?
            ORDER BY expense_date DESC, id DESC
        `, [id]);
        const totalExpenses = expenseRows.reduce((sum, row) => sum + money(row.amount), 0);
        const grossProfit = contractValue - totalExpenses;
        const grossMargin = contractValue > 0 ? (grossProfit / contractValue) * 100 : 0;

        return res.json({
            success: true,
            project: {
                ...project,
                contract_value: contractValue
            },
            summary: {
                invoice_count: invoiceRows.length,
                invoice_total: Number(invoiceTotal.toFixed(2)),
                invoice_paid: Number(invoicePaid.toFixed(2)),
                invoice_outstanding: Number(
                    Math.max(invoiceTotal - invoicePaid, 0).toFixed(2)
                ),
                payment_count: paymentRows.length,
                payment_registered: Number(paymentRegistered.toFixed(2)),
                payment_paid: Number(paymentPaid.toFixed(2)),
                contract_remaining: Number(
                    Math.max(contractValue - paymentPaid, 0).toFixed(2)
                ),
                paid_percentage: Number(paidPercentage.toFixed(2)),
                invoice_outstanding: Number(invoiceOutstanding.toFixed(2)),
                overdue_payments: overduePayments,
                total_expenses: Number(totalExpenses.toFixed(2)),
                gross_profit: Number(grossProfit.toFixed(2)),
                gross_margin_percentage: Number(grossMargin.toFixed(2)),
                latest_payment: latestPayment ? {
                    ...latestPayment,
                    amount: money(latestPayment.amount)
                } : null,
                latest_invoice: latestInvoice ? {
                    ...latestInvoice,
                    total_amount: money(latestInvoice.total_amount),
                    paid_amount: money(latestInvoice.paid_amount)
                } : null
            },
            invoices: invoiceRows.map(row => ({
                ...row,
                invoice_amount: money(row.invoice_amount),
                vat_amount: money(row.vat_amount),
                total_amount: money(row.total_amount),
                paid_amount: money(row.paid_amount),
                outstanding_amount: Math.max(
                    money(row.total_amount) - money(row.paid_amount), 0
                )
            })),
            payments: paymentRows.map(row => ({
                ...row,
                amount: money(row.amount)
            })),
            expenses: expenseRows.map(row => ({ ...row, amount: money(row.amount) }))
        });
    } catch (error) {
        console.error("GET PROJECT SUMMARY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب تفاصيل المشروع",
            error: error.message
        });
    }
});

app.post("/api/projects", requirePermission('projects.write'), async (req, res) => {
    try {
        const projectName = cleanString(req.body.project_name);
        const clientName = cleanString(req.body.client_name);
        const contractNumber = cleanString(req.body.contract_number);
        const contractValue = money(req.body.contract_value);
        const startDate = cleanString(req.body.start_date);
        const endDate = cleanString(req.body.end_date);
        const statusValues = ["Active", "Completed", "On Hold", "Cancelled"];
        const status = statusValues.includes(req.body.status) ? req.body.status : "Active";
        const notes = cleanString(req.body.notes);
        const progressPercentage = Math.min(Math.max(Number(req.body.progress_percentage || 0), 0), 100);
        if (!projectName) return res.status(400).json({ success: false, message: "اسم المشروع مطلوب" });
        if (contractValue < 0) return res.status(400).json({ success: false, message: "قيمة العقد غير صحيحة" });
        if (startDate && endDate && startDate > endDate) return res.status(400).json({ success: false, message: "تاريخ نهاية المشروع يجب أن يكون بعد تاريخ البداية" });
        if (contractNumber) {
            const [duplicateRows] = await db.query(`SELECT id FROM projects WHERE contract_number = ? LIMIT 1`, [contractNumber]);
            if (duplicateRows.length) return res.status(409).json({ success: false, message: "رقم العقد مستخدم بالفعل" });
        }
        const [result] = await db.query(`INSERT INTO projects (project_name, client_name, contract_number, contract_value, start_date, end_date, status, progress_percentage, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [projectName, clientName, contractNumber, contractValue, startDate || null, endDate || null, status, progressPercentage, notes]);
        return res.status(201).json({ success: true, message: "تم إضافة المشروع بنجاح", project_id: result.insertId });
    } catch (error) {
        console.error("CREATE PROJECT ERROR:", error);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء إضافة المشروع", error: error.message });
    }
});

app.put("/api/projects/:id", requirePermission('projects.write'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "رقم المشروع غير صحيح" });
        const projectName = cleanString(req.body.project_name);
        const clientName = cleanString(req.body.client_name);
        const contractNumber = cleanString(req.body.contract_number);
        const contractValue = money(req.body.contract_value);
        const startDate = cleanString(req.body.start_date);
        const endDate = cleanString(req.body.end_date);
        const statusValues = ["Active", "Completed", "On Hold", "Cancelled"];
        const status = statusValues.includes(req.body.status) ? req.body.status : "Active";
        const notes = cleanString(req.body.notes);
        const progressPercentage = Math.min(Math.max(Number(req.body.progress_percentage || 0), 0), 100);
        if (!projectName) return res.status(400).json({ success: false, message: "اسم المشروع مطلوب" });
        if (contractValue < 0) return res.status(400).json({ success: false, message: "قيمة العقد غير صحيحة" });
        if (startDate && endDate && startDate > endDate) return res.status(400).json({ success: false, message: "تاريخ نهاية المشروع يجب أن يكون بعد تاريخ البداية" });
        if (contractNumber) {
            const [duplicateRows] = await db.query(`SELECT id FROM projects WHERE contract_number = ? AND id <> ? LIMIT 1`, [contractNumber, id]);
            if (duplicateRows.length) return res.status(409).json({ success: false, message: "رقم العقد مستخدم بالفعل" });
        }
        const [result] = await db.query(`UPDATE projects SET project_name = ?, client_name = ?, contract_number = ?, contract_value = ?, start_date = ?, end_date = ?, status = ?, progress_percentage = ?, notes = ? WHERE id = ?`, [projectName, clientName, contractNumber, contractValue, startDate || null, endDate || null, status, progressPercentage, notes, id]);
        if (!result.affectedRows) return res.status(404).json({ success: false, message: "المشروع غير موجود" });
        return res.json({ success: true, message: "تم تعديل المشروع بنجاح", project_id: id });
    } catch (error) {
        console.error("UPDATE PROJECT ERROR:", error);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء تعديل المشروع", error: error.message });
    }
});

app.delete("/api/projects/:id", requirePermission('projects.write'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "رقم المشروع غير صحيح" });
        const [invoiceRows] = await db.query(`SELECT id FROM invoices WHERE project_id = ? LIMIT 1`, [id]);
        if (invoiceRows.length) return res.status(409).json({ success: false, message: "لا يمكن حذف المشروع لأنه مرتبط بفواتير. احذف أو انقل الفواتير أولاً." });

        const [paymentRows] = await db.query(`SELECT id FROM payments WHERE project_id = ? LIMIT 1`, [id]);
        if (paymentRows.length) return res.status(409).json({ success: false, message: "لا يمكن حذف المشروع لأنه مرتبط بمدفوعات. احذف المدفوعات أولاً." });
        const [result] = await db.query(`DELETE FROM projects WHERE id = ?`, [id]);
        if (!result.affectedRows) return res.status(404).json({ success: false, message: "المشروع غير موجود" });
        return res.json({ success: true, message: "تم حذف المشروع بنجاح" });
    } catch (error) {
        console.error("DELETE PROJECT ERROR:", error);
        return res.status(500).json({ success: false, message: "لا يمكن حذف المشروع", error: error.message });
    }
});

// =====================================================
// INVOICES API
// =====================================================

app.get(
    "/api/invoices/projects",
    async (req, res) => {

        try {

            const [rows] =
                await db.query(`

                    SELECT
                        id,
                        project_name,
                        client_name,
                        contract_number,
                        contract_value,
                        status

                    FROM projects

                    ORDER BY project_name ASC

                `);

            return res.json({

                success: true,

                count: rows.length,

                projects: rows

            });

        } catch (error) {

            console.error(
                "GET INVOICE PROJECTS ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب المشاريع",

                error:
                    error.message

            });

        }

    }
);

// GET INVOICES
app.get(
    "/api/invoices",
    async (req, res) => {

        try {

            const search =
                cleanString(req.query.search);

            const status =
                cleanString(req.query.status);

            const month =
                cleanString(req.query.month);

            let sql = `

                SELECT

                    i.*,

                    p.project_name,

                    p.client_name,

                    p.contract_number,

                    COALESCE(
                        (
                            SELECT SUM(pay.amount)
                            FROM payments pay
                            WHERE pay.invoice_id = i.id
                              AND pay.status = 'Paid'
                        ),
                        0
                    ) AS paid_amount,

                    GREATEST(
                        i.total_amount -
                        COALESCE(
                            (
                                SELECT SUM(pay2.amount)
                                FROM payments pay2
                                WHERE pay2.invoice_id = i.id
                                  AND pay2.status = 'Paid'
                            ),
                            0
                        ),
                        0
                    ) AS outstanding_amount

                FROM invoices i

                INNER JOIN projects p
                    ON p.id = i.project_id

            `;

            const conditions = [];
            const params = [];

            if (search) {

                conditions.push(`

                    (
                        i.invoice_number LIKE ?
                        OR p.project_name LIKE ?
                        OR p.client_name LIKE ?
                    )

                `);

                const keyword =
                    `%${search}%`;

                params.push(
                    keyword,
                    keyword,
                    keyword
                );

            }

            if (status) {

                conditions.push(
                    "i.status = ?"
                );

                params.push(status);

            }

            if (month) {

                conditions.push(`

                    DATE_FORMAT(
                        i.invoice_date,
                        '%Y-%m'
                    ) = ?

                `);

                params.push(month);

            }

            if (conditions.length) {

                sql +=
                    " WHERE " +
                    conditions.join(
                        " AND "
                    );

            }

            sql += `

                ORDER BY
                    i.id DESC

            `;

            const [rows] =
                await db.query(
                    sql,
                    params
                );

            return res.json({

                success: true,

                count:
                    rows.length,

                invoices:
                    rows

            });

        } catch (error) {

            console.error(
                "GET INVOICES ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب الفواتير",

                error:
                    error.message

            });

        }

    }
);

// INVOICE SUMMARY
app.get(
    "/api/invoices/stats/summary",
    async (req, res) => {

        try {

            const month =
                cleanString(req.query.month);

            let sql = `

                SELECT

                    COUNT(*) AS total_records,

                    COALESCE(
                        SUM(invoice_amount),
                        0
                    ) AS subtotal,

                    COALESCE(
                        SUM(vat_amount),
                        0
                    ) AS vat,

                    COALESCE(
                        SUM(total_amount),
                        0
                    ) AS total_amount,

                    COALESCE(
                        (
                            SELECT SUM(pay.amount)
                            FROM payments pay
                            INNER JOIN invoices pi
                                ON pi.id = pay.invoice_id
                            WHERE pay.status = 'Paid'
                              AND (
                                  ? IS NULL
                                  OR DATE_FORMAT(pi.invoice_date, '%Y-%m') = ?
                              )
                        ),
                        0
                    ) AS paid_amount,

                    GREATEST(
                        COALESCE(SUM(total_amount), 0) -
                        COALESCE(
                            (
                                SELECT SUM(pay2.amount)
                                FROM payments pay2
                                INNER JOIN invoices pi2
                                    ON pi2.id = pay2.invoice_id
                                WHERE pay2.status = 'Paid'
                                  AND (
                                      ? IS NULL
                                      OR DATE_FORMAT(pi2.invoice_date, '%Y-%m') = ?
                                  )
                            ),
                            0
                        ),
                        0
                    ) AS outstanding_amount

                FROM invoices

            `;

            const params = [
                month || null,
                month || null,
                month || null,
                month || null
            ];

            if (month) {

                sql += `

                    WHERE
                        DATE_FORMAT(
                            invoice_date,
                            '%Y-%m'
                        ) = ?

                `;

                params.push(month);

            }

            if (!month) {
                // The four placeholders above are intentionally NULL.
                // They make the payment subqueries work for an all-month summary.
            }

            const [rows] =
                await db.query(
                    sql,
                    params
                );

            const summary =
                rows[0] || {};

            return res.json({

                success: true,

                month:
                    month || null,

                total_records:
                    Number(
                        summary.total_records || 0
                    ),

                subtotal:
                    money(summary.subtotal),

                vat:
                    money(summary.vat),

                total_amount:
                    money(summary.total_amount),

                paid_amount:
                    money(summary.paid_amount),

                outstanding_amount:
                    money(
                        summary.outstanding_amount
                    )

            });

        } catch (error) {

            console.error(
                "INVOICE SUMMARY ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب ملخص الفواتير",

                error:
                    error.message

            });

        }

    }
);

// GET INVOICE BY ID
app.get(
    "/api/invoices/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الفاتورة غير صحيح"

                });

            }

            const [rows] =
                await db.query(`

                    SELECT

                        i.*,

                        p.project_name,

                        p.client_name,

                        p.contract_number,

                        COALESCE(
                            (
                                SELECT SUM(pay.amount)
                                FROM payments pay
                                WHERE pay.invoice_id = i.id
                                  AND pay.status = 'Paid'
                            ),
                            0
                        ) AS paid_amount,

                        GREATEST(
                            i.total_amount -
                            COALESCE(
                                (
                                    SELECT SUM(pay2.amount)
                                    FROM payments pay2
                                    WHERE pay2.invoice_id = i.id
                                      AND pay2.status = 'Paid'
                                ),
                                0
                            ),
                            0
                        ) AS outstanding_amount

                    FROM invoices i

                    INNER JOIN projects p
                        ON p.id = i.project_id

                    WHERE i.id = ?

                    LIMIT 1

                `, [id]);

            if (!rows.length) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الفاتورة غير موجودة"

                });

            }

            return res.json({

                success: true,

                invoice:
                    rows[0]

            });

        } catch (error) {

            console.error(
                "GET INVOICE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب الفاتورة",

                error:
                    error.message

            });

        }

    }
);

// CREATE INVOICE
app.post(
    "/api/invoices",
    requirePermission('invoices.write'),
    async (req, res) => {

        try {

            const projectId =
                Number(req.body.project_id);

            const invoiceNumber =
                cleanString(
                    req.body.invoice_number
                );

            const invoiceDate =
                cleanString(
                    req.body.invoice_date
                );

            const invoiceAmount =
                money(
                    req.body.invoice_amount
                );

            const vatAmount =
                Number(
                    (
                        invoiceAmount * 0.05
                    ).toFixed(2)
                );

            const totalAmount =
                Number(
                    (
                        invoiceAmount +
                        vatAmount
                    ).toFixed(2)
                );

            const statusValues = [
                "Draft",
                "Submitted",
                "Approved",
                "Rejected",
                "Paid"
            ];

            const status =
                statusValues.includes(
                    req.body.status
                )
                    ? req.body.status
                    : "Draft";

            const notes =
                cleanString(
                    req.body.notes
                );

            if (!projectId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "المشروع مطلوب"

                });

            }

            if (!invoiceNumber) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الفاتورة مطلوب"

                });

            }

            if (!invoiceDate) {

                return res.status(400).json({

                    success: false,

                    message:
                        "تاريخ الفاتورة مطلوب"

                });

            }

            if (invoiceAmount < 0) {

                return res.status(400).json({

                    success: false,

                    message:
                        "مبلغ الفاتورة غير صحيح"

                });

            }

            const [projectRows] =
                await db.query(`

                    SELECT id

                    FROM projects

                    WHERE id = ?

                    LIMIT 1

                `, [projectId]);

            if (!projectRows.length) {

                return res.status(404).json({

                    success: false,

                    message:
                        "المشروع غير موجود"

                });

            }

            const [duplicateRows] =
                await db.query(`

                    SELECT id

                    FROM invoices

                    WHERE invoice_number = ?

                    LIMIT 1

                `, [invoiceNumber]);

            if (duplicateRows.length) {

                return res.status(409).json({

                    success: false,

                    message:
                        "رقم الفاتورة مستخدم بالفعل"

                });

            }

            const [result] =
                await db.query(`

                    INSERT INTO invoices
                    (
                        project_id,
                        invoice_number,
                        invoice_date,
                        invoice_amount,
                        vat_amount,
                        total_amount,
                        status,
                        notes
                    )

                    VALUES
                    (
                        ?, ?, ?, ?, ?, ?, ?, ?
                    )

                `, [

                    projectId,
                    invoiceNumber,
                    invoiceDate,
                    invoiceAmount,
                    vatAmount,
                    totalAmount,
                    status,
                    notes

                ]);

            return res.status(201).json({

                success: true,

                message:
                    "تم إنشاء الفاتورة بنجاح",

                invoice_id:
                    result.insertId,

                invoice_amount:
                    invoiceAmount,

                vat_amount:
                    vatAmount,

                total_amount:
                    totalAmount

            });

        } catch (error) {

            console.error(
                "CREATE INVOICE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء إنشاء الفاتورة",

                error:
                    error.message

            });

        }

    }
);

// UPDATE INVOICE
app.put(
    "/api/invoices/:id",
    requirePermission('invoices.write'),
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الفاتورة غير صحيح"

                });

            }

            const projectId =
                Number(req.body.project_id);

            const invoiceNumber =
                cleanString(
                    req.body.invoice_number
                );

            const invoiceDate =
                cleanString(
                    req.body.invoice_date
                );

            const invoiceAmount =
                money(
                    req.body.invoice_amount
                );

            const vatAmount =
                Number(
                    (
                        invoiceAmount * 0.05
                    ).toFixed(2)
                );

            const totalAmount =
                Number(
                    (
                        invoiceAmount +
                        vatAmount
                    ).toFixed(2)
                );

            const statusValues = [
                "Draft",
                "Submitted",
                "Approved",
                "Rejected",
                "Paid"
            ];

            const status =
                statusValues.includes(
                    req.body.status
                )
                    ? req.body.status
                    : "Draft";

            const notes =
                cleanString(
                    req.body.notes
                );

            if (
                !projectId ||
                !invoiceNumber ||
                !invoiceDate
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "المشروع ورقم الفاتورة والتاريخ مطلوبة"

                });

            }

            const [duplicateRows] =
                await db.query(`

                    SELECT id

                    FROM invoices

                    WHERE

                        invoice_number = ?

                        AND id <> ?

                    LIMIT 1

                `, [
                    invoiceNumber,
                    id
                ]);

            if (duplicateRows.length) {

                return res.status(409).json({

                    success: false,

                    message:
                        "رقم الفاتورة مستخدم بالفعل"

                });

            }

            const [result] =
                await db.query(`

                    UPDATE invoices

                    SET

                        project_id = ?,
                        invoice_number = ?,
                        invoice_date = ?,
                        invoice_amount = ?,
                        vat_amount = ?,
                        total_amount = ?,
                        status = ?,
                        notes = ?

                    WHERE id = ?

                `, [

                    projectId,
                    invoiceNumber,
                    invoiceDate,
                    invoiceAmount,
                    vatAmount,
                    totalAmount,
                    status,
                    notes,
                    id

                ]);

            if (!result.affectedRows) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الفاتورة غير موجودة"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم تحديث الفاتورة بنجاح",

                invoice_id:
                    id,

                invoice_amount:
                    invoiceAmount,

                vat_amount:
                    vatAmount,

                total_amount:
                    totalAmount

            });

        } catch (error) {

            console.error(
                "UPDATE INVOICE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء تحديث الفاتورة",

                error:
                    error.message

            });

        }

    }
);

// DELETE INVOICE
app.delete(
    "/api/invoices/:id",
    requirePermission('invoices.write'),
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم الفاتورة غير صحيح"

                });

            }

            const [paymentRows] =
                await db.query(`

                    SELECT id

                    FROM payments

                    WHERE invoice_id = ?

                    LIMIT 1

                `, [id]);

            if (paymentRows.length) {

                return res.status(409).json({

                    success: false,

                    message:
                        "لا يمكن حذف الفاتورة لأنها مرتبطة بدفعة. احذف أو عدّل الدفعة أولاً."

                });

            }

            const [result] =
                await db.query(`

                    DELETE FROM invoices

                    WHERE id = ?

                `, [id]);

            if (!result.affectedRows) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الفاتورة غير موجودة"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم حذف الفاتورة بنجاح"

            });

        } catch (error) {

            console.error(
                "DELETE INVOICE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء حذف الفاتورة",

                error:
                    error.message

            });

        }

    }
);


// =====================================================
// PAYMENTS API
// =====================================================

const PAYMENT_STATUSES = [
    "Draft",
    "Submitted",
    "Under Review",
    "Certified",
    "Approved",
    "Pending",
    "Paid",
    "Rejected"
];

function validDate(value) {
    const v = cleanString(value);
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const [y, m, day] = v.split("-").map(Number);
    if (y < 1900 || y > 2100) return null;
    if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return null;
    return v;
}

async function addPaymentHistory(connection, paymentId, oldStatus, newStatus, notes = null) {
    if (String(oldStatus || "") === String(newStatus || "")) return;
    await connection.query(`
        INSERT INTO payment_status_history
        (payment_id, old_status, new_status, notes)
        VALUES (?, ?, ?, ?)
    `, [paymentId, oldStatus || null, newStatus || null, notes || null]);
}

// GET PROJECTS FOR PAYMENTS
app.get("/api/payments/projects", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT
                p.id,
                p.project_name,
                p.client_name,
                p.contract_number,
                p.contract_value,
                p.status,
                COALESCE((
                    SELECT SUM(pay.amount)
                    FROM payments pay
                    WHERE pay.project_id = p.id
                      AND pay.status <> 'Rejected'
                ), 0) AS registered_payments,
                COALESCE((
                    SELECT SUM(pay.amount)
                    FROM payments pay
                    WHERE pay.project_id = p.id
                      AND pay.status = 'Paid'
                ), 0) AS paid_amount
            FROM projects p
            ORDER BY p.project_name ASC
        `);

        return res.json({
            success: true,
            count: rows.length,
            projects: rows.map(p => {
                const contract = money(p.contract_value);
                const registered = money(p.registered_payments);
                const paid = money(p.paid_amount);
                return {
                    ...p,
                    contract_value: contract,
                    registered_payments: registered,
                    paid_amount: paid,
                    remaining_contract: Math.max(contract - paid, 0)
                };
            })
        });
    } catch (error) {
        console.error("GET PAYMENT PROJECTS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب المشاريع للمدفوعات",
            error: error.message
        });
    }
});

// GET INVOICES FOR A PROJECT (OPTIONAL LINK)
app.get("/api/payments/invoices", async (req, res) => {
    try {
        const projectId = Number(req.query.project_id || 0);
        const conditions = [];
        const params = [];

        if (projectId) {
            conditions.push("i.project_id = ?");
            params.push(projectId);
        }

        let sql = `
            SELECT
                i.id,
                i.project_id,
                i.invoice_number,
                i.invoice_date,
                i.total_amount,
                i.status,
                p.project_name,
                p.client_name,
                COALESCE((
                    SELECT SUM(pay.amount)
                    FROM payments pay
                    WHERE pay.invoice_id = i.id
                      AND pay.status = 'Paid'
                ), 0) AS paid_amount
            FROM invoices i
            INNER JOIN projects p ON p.id = i.project_id
        `;

        if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
        sql += " ORDER BY i.invoice_date DESC, i.id DESC";

        const [rows] = await db.query(sql, params);

        return res.json({
            success: true,
            count: rows.length,
            invoices: rows.map(i => {
                const total = money(i.total_amount);
                const paid = money(i.paid_amount);
                return {
                    ...i,
                    total_amount: total,
                    paid_amount: paid,
                    outstanding_amount: Math.max(total - paid, 0)
                };
            })
        });
    } catch (error) {
        console.error("GET PAYMENT INVOICES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب الفواتير للمدفوعات",
            error: error.message
        });
    }
});

// GET PAYMENTS
app.get("/api/payments", async (req, res) => {
    try {
        const search = cleanString(req.query.search);
        const status = cleanString(req.query.status);
        const projectId = Number(req.query.project_id || 0);
        const month = cleanString(req.query.month);

        let sql = `
            SELECT
                pay.*,
                pr.project_name,
                pr.client_name,
                pr.contract_number,
                pr.contract_value,
                i.invoice_number,
                i.invoice_date,
                i.total_amount AS invoice_total,
                COALESCE((
                    SELECT SUM(p2.amount)
                    FROM payments p2
                    WHERE p2.project_id = pay.project_id
                      AND p2.status = 'Paid'
                ), 0) AS project_paid_amount,
                COALESCE((
                    SELECT SUM(p3.amount)
                    FROM payments p3
                    WHERE p3.invoice_id = pay.invoice_id
                      AND p3.invoice_id IS NOT NULL
                      AND p3.status = 'Paid'
                ), 0) AS invoice_paid_amount
            FROM payments pay
            INNER JOIN projects pr ON pr.id = pay.project_id
            LEFT JOIN invoices i ON i.id = pay.invoice_id
        `;

        const conditions = [];
        const params = [];

        if (search) {
            const q = `%${search}%`;
            conditions.push(`
                (
                    pay.payment_number LIKE ?
                    OR pay.payment_type LIKE ?
                    OR pr.project_name LIKE ?
                    OR pr.client_name LIKE ?
                    OR pr.contract_number LIKE ?
                    OR i.invoice_number LIKE ?
                )
            `);
            params.push(q, q, q, q, q, q);
        }

        if (status && PAYMENT_STATUSES.includes(status)) {
            conditions.push("pay.status = ?");
            params.push(status);
        }

        if (projectId) {
            conditions.push("pay.project_id = ?");
            params.push(projectId);
        }

        if (month) {
            conditions.push(`
                DATE_FORMAT(COALESCE(pay.received_date, pay.approved_date, pay.submitted_date), '%Y-%m') = ?
            `);
            params.push(month);
        }

        if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
        sql += " ORDER BY pay.id DESC";

        const [rows] = await db.query(sql, params);

        return res.json({
            success: true,
            count: rows.length,
            payments: rows.map(row => ({
                ...row,
                amount: money(row.amount),
                project_paid_amount: money(row.project_paid_amount),
                project_remaining_contract: Math.max(
                    money(row.contract_value) - money(row.project_paid_amount),
                    0
                ),
                invoice_total: money(row.invoice_total),
                invoice_paid_amount: money(row.invoice_paid_amount),
                invoice_outstanding_amount: Math.max(
                    money(row.invoice_total) - money(row.invoice_paid_amount),
                    0
                )
            }))
        });
    } catch (error) {
        console.error("GET PAYMENTS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب المدفوعات",
            error: error.message
        });
    }
});

// PAYMENT SUMMARY
app.get("/api/payments/stats/summary", async (req, res) => {
    try {
        const month = cleanString(req.query.month);
        let sql = `
            SELECT
                COUNT(*) AS total_records,
                COALESCE(SUM(CASE WHEN status = 'Paid' THEN amount ELSE 0 END), 0) AS total_paid,
                COALESCE(SUM(CASE WHEN status IN ('Pending','Submitted','Under Review','Certified','Approved') THEN amount ELSE 0 END), 0) AS total_pending,
                COALESCE(SUM(CASE WHEN status = 'Rejected' THEN amount ELSE 0 END), 0) AS total_rejected
            FROM payments
        `;
        const params = [];

        if (month) {
            sql += `
                WHERE DATE_FORMAT(
                    COALESCE(received_date, approved_date, submitted_date),
                    '%Y-%m'
                ) = ?
            `;
            params.push(month);
        }

        const [rows] = await db.query(sql, params);
        const s = rows[0] || {};

        return res.json({
            success: true,
            total_records: Number(s.total_records || 0),
            total_paid: money(s.total_paid),
            total_pending: money(s.total_pending),
            total_rejected: money(s.total_rejected)
        });
    } catch (error) {
        console.error("PAYMENT SUMMARY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب ملخص المدفوعات",
            error: error.message
        });
    }
});

// GET PAYMENT BY ID
app.get("/api/payments/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: "رقم الدفعة غير صحيح"
            });
        }

        const [rows] = await db.query(`
            SELECT
                pay.*,
                pr.project_name,
                pr.client_name,
                pr.contract_number,
                pr.contract_value,
                i.invoice_number,
                i.invoice_date,
                i.total_amount AS invoice_total
            FROM payments pay
            INNER JOIN projects pr ON pr.id = pay.project_id
            LEFT JOIN invoices i ON i.id = pay.invoice_id
            WHERE pay.id = ?
            LIMIT 1
        `, [id]);

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "الدفعة غير موجودة"
            });
        }

        return res.json({ success: true, payment: rows[0] });
    } catch (error) {
        console.error("GET PAYMENT ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب الدفعة",
            error: error.message
        });
    }
});

// CREATE PAYMENT
app.post("/api/payments", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const projectId = Number(req.body.project_id);
        const invoiceId = Number(req.body.invoice_id || 0) || null;
        const paymentNumber = cleanString(req.body.payment_number);
        const paymentType = cleanString(req.body.payment_type);
        const periodFrom = validDate(req.body.period_from);
        const periodTo = validDate(req.body.period_to);
        const amount = money(req.body.amount);
        const submittedDate = validDate(req.body.submitted_date);
        const approvedDate = validDate(req.body.approved_date);
        const dueDate = validDate(req.body.due_date);
        const receivedDate = validDate(req.body.received_date);
        const notes = cleanString(req.body.notes);
        const status = PAYMENT_STATUSES.includes(req.body.status)
            ? req.body.status
            : "Draft";

        if (!projectId || !paymentNumber || amount <= 0) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "المشروع ورقم الدفعة والمبلغ مطلوبة"
            });
        }

        if (req.body.period_from && !periodFrom) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "تاريخ بداية الفترة غير صحيح"
            });
        }

        if (req.body.period_to && !periodTo) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "تاريخ نهاية الفترة غير صحيح"
            });
        }

        if (periodFrom && periodTo && periodFrom > periodTo) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "تاريخ بداية الفترة يجب أن يسبق تاريخ النهاية"
            });
        }

        const [projectRows] = await connection.query(
            "SELECT id FROM projects WHERE id = ? LIMIT 1",
            [projectId]
        );
        if (!projectRows.length) {
            connection.release();
            return res.status(404).json({
                success: false,
                message: "المشروع غير موجود"
            });
        }

        if (invoiceId) {
            const [invoiceRows] = await connection.query(
                "SELECT id, project_id FROM invoices WHERE id = ? LIMIT 1",
                [invoiceId]
            );
            if (!invoiceRows.length) {
                connection.release();
                return res.status(404).json({
                    success: false,
                    message: "الفاتورة غير موجودة"
                });
            }
            if (Number(invoiceRows[0].project_id) !== projectId) {
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: "الفاتورة لا تتبع المشروع المختار"
                });
            }
        }

        await connection.beginTransaction();

        const [result] = await connection.query(`
            INSERT INTO payments
            (
                project_id,
                invoice_id,
                payment_number,
                payment_type,
                period_from,
                period_to,
                amount,
                submitted_date,
                approved_date,
                due_date,
                received_date,
                status,
                notes
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            projectId,
            invoiceId,
            paymentNumber,
            paymentType,
            periodFrom,
            periodTo,
            amount,
            submittedDate,
            approvedDate,
            dueDate,
            receivedDate,
            status,
            notes
        ]);

        await addPaymentHistory(connection, result.insertId, null, status, notes);
        await connection.commit();
        connection.release();

        return res.status(201).json({
            success: true,
            message: "تم تسجيل الدفعة بنجاح",
            payment_id: result.insertId
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        console.error("CREATE PAYMENT ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء تسجيل الدفعة",
            error: error.message
        });
    }
});

// UPDATE PAYMENT
app.put("/api/payments/:id", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const id = Number(req.params.id);
        if (!id) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "رقم الدفعة غير صحيح"
            });
        }

        const [oldRows] = await connection.query(
            "SELECT * FROM payments WHERE id = ? LIMIT 1",
            [id]
        );

        if (!oldRows.length) {
            connection.release();
            return res.status(404).json({
                success: false,
                message: "الدفعة غير موجودة"
            });
        }

        const old = oldRows[0];
        const projectId = Number(req.body.project_id || old.project_id);
        const invoiceId = Number(req.body.invoice_id || 0) || null;
        const paymentNumber = cleanString(req.body.payment_number) || old.payment_number;
        const paymentType = cleanString(req.body.payment_type);
        const periodFrom = validDate(req.body.period_from);
        const periodTo = validDate(req.body.period_to);
        const amount = money(req.body.amount);
        const submittedDate = validDate(req.body.submitted_date);
        const approvedDate = validDate(req.body.approved_date);
        const dueDate = validDate(req.body.due_date);
        const receivedDate = validDate(req.body.received_date);
        const notes = cleanString(req.body.notes);
        const status = PAYMENT_STATUSES.includes(req.body.status)
            ? req.body.status
            : old.status || "Draft";

        if (!projectId || !paymentNumber || amount <= 0) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "المشروع ورقم الدفعة والمبلغ مطلوبة"
            });
        }

        const [projectRows] = await connection.query(
            "SELECT id FROM projects WHERE id = ? LIMIT 1",
            [projectId]
        );
        if (!projectRows.length) {
            connection.release();
            return res.status(404).json({
                success: false,
                message: "المشروع غير موجود"
            });
        }

        if (invoiceId) {
            const [invoiceRows] = await connection.query(
                "SELECT id, project_id FROM invoices WHERE id = ? LIMIT 1",
                [invoiceId]
            );
            if (!invoiceRows.length) {
                connection.release();
                return res.status(404).json({
                    success: false,
                    message: "الفاتورة غير موجودة"
                });
            }
            if (Number(invoiceRows[0].project_id) !== projectId) {
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: "الفاتورة لا تتبع المشروع المختار"
                });
            }
        }

        await connection.beginTransaction();

        await connection.query(`
            UPDATE payments
            SET
                project_id = ?,
                invoice_id = ?,
                payment_number = ?,
                payment_type = ?,
                period_from = ?,
                period_to = ?,
                amount = ?,
                submitted_date = ?,
                approved_date = ?,
                due_date = ?,
                received_date = ?,
                status = ?,
                notes = ?
            WHERE id = ?
        `, [
            projectId,
            invoiceId,
            paymentNumber,
            paymentType,
            periodFrom,
            periodTo,
            amount,
            submittedDate,
            approvedDate,
            dueDate,
            receivedDate,
            status,
            notes,
            id
        ]);

        await addPaymentHistory(connection, id, old.status, status, notes);
        await connection.commit();
        connection.release();

        return res.json({
            success: true,
            message: "تم تعديل الدفعة بنجاح"
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        console.error("UPDATE PAYMENT ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء تعديل الدفعة",
            error: error.message
        });
    }
});

// DELETE PAYMENT
app.delete("/api/payments/:id", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const id = Number(req.params.id);
        if (!id) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "رقم الدفعة غير صحيح"
            });
        }

        const [rows] = await connection.query(
            "SELECT id FROM payments WHERE id = ? LIMIT 1",
            [id]
        );

        if (!rows.length) {
            connection.release();
            return res.status(404).json({
                success: false,
                message: "الدفعة غير موجودة"
            });
        }

        await connection.beginTransaction();

        // payment_status_history has a foreign key to payments without
        // ON DELETE CASCADE, so history must be removed first.
        await connection.query(
            "DELETE FROM payment_status_history WHERE payment_id = ?",
            [id]
        );

        await connection.query(
            "DELETE FROM payments WHERE id = ?",
            [id]
        );

        await connection.commit();
        connection.release();

        return res.json({
            success: true,
            message: "تم حذف الدفعة بنجاح"
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        console.error("DELETE PAYMENT ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء حذف الدفعة",
            error: error.message
        });
    }
});

// =====================================================
// ATTENDANCE API
// =====================================================

// =====================================================
// GET ACTIVE EMPLOYEES FOR ATTENDANCE
// =====================================================

app.get(
    "/api/attendance/employees",
    async (req, res) => {

        try {

            const [rows] =
                await db.query(`

                    SELECT

                        id,
                        employee_code,
                        full_name,
                        job_title,
                        department

                    FROM employees

                    WHERE

                        employment_status = 'Active'

                        AND status = 'active'

                    ORDER BY full_name ASC

                `);

            return res.json({

                success: true,

                count:
                    rows.length,

                employees:
                    rows

            });

        } catch (error) {

            console.error(
                "GET ATTENDANCE EMPLOYEES ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب موظفي الحضور",

                error:
                    error.message

            });

        }

    }
);



// =====================================================
// AVAILABLE ATTENDANCE MONTHS
// =====================================================
app.get("/api/attendance/months", async (req,res)=>{
    try {
        const [rows]=await db.query(`
            SELECT DISTINCT DATE_FORMAT(attendance_date,'%Y-%m') AS month
            FROM attendance
            WHERE attendance_date IS NOT NULL
            ORDER BY month DESC
        `);
        return res.json({
            success:true,
            months:rows.map(r=>r.month).filter(Boolean)
        });
    } catch(error) {
        console.error("ATTENDANCE MONTHS ERROR:",error);
        return res.status(500).json({
            success:false,
            message:"تعذر تحميل الشهور السابقة",
            error:error.message
        });
    }
});

// =====================================================
// MONTHLY ATTENDANCE MATRIX
// =====================================================

app.get("/api/attendance/monthly", async (req, res) => {
    try {
        const month = cleanString(req.query.month);
        const selectedDate = cleanString(req.query.date) || "";

        if (!/^\d{4}-\d{2}$/.test(month || "")) {
            return res.status(400).json({
                success: false,
                message: "يجب تحديد الشهر بصيغة YYYY-MM"
            });
        }

        const [employees] = await db.query(`
            SELECT id, employee_code, full_name, job_title, department
            FROM employees
            WHERE employment_status = 'Active'
              AND status = 'active'
            ORDER BY full_name ASC
        `);

        const [records] = await db.query(`
            SELECT
                ar.id,
                ar.employee_id,
                DATE_FORMAT(ar.attendance_date, '%Y-%m-%d') AS attendance_date,
                ar.check_in,
                ar.check_out,
                ar.status,
                ar.notes
            FROM attendance_records ar
            WHERE DATE_FORMAT(ar.attendance_date, '%Y-%m') = ?
            ORDER BY ar.attendance_date ASC, ar.employee_id ASC
        `, [month]);

        // Automatically register today's work as Present for active employees.
        // We do not create future dates; their cells remain ready to be changed.
        const today = new Date();
        const todayString = [
            today.getFullYear(),
            String(today.getMonth() + 1).padStart(2, "0"),
            String(today.getDate()).padStart(2, "0")
        ].join("-");
        if (month === todayString.substring(0, 7)) {
            const exists = new Set(
                records
                    .filter(r => String(r.attendance_date).substring(0,10) === todayString)
                    .map(r => Number(r.employee_id))
            );
            const missing = employees.filter(e => !exists.has(Number(e.id)));
            if (missing.length) {
                const values = missing.map(e => [e.id, todayString, "Present"]);
                await db.query(`
                    INSERT IGNORE INTO attendance_records
                        (employee_id, attendance_date, status)
                    VALUES ?
                `, [values]);
                const [todayRows] = await db.query(`
                    SELECT
                        ar.id,
                        ar.employee_id,
                        DATE_FORMAT(ar.attendance_date, '%Y-%m-%d') AS attendance_date,
                        ar.check_in,
                        ar.check_out,
                        ar.status,
                        ar.notes
                    FROM attendance_records ar
                    WHERE ar.attendance_date = ?
                    ORDER BY ar.employee_id ASC
                `, [todayString]);
                records.splice(0, records.length, ...records.filter(r => String(r.attendance_date).substring(0,10) !== todayString), ...todayRows);
            }
        }

        const [dayRows] = await db.query(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) AS present,
                SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) AS absent,
                SUM(CASE WHEN status = 'Leave' THEN 1 ELSE 0 END) AS leave_count,
                SUM(CASE WHEN status = 'Off' THEN 1 ELSE 0 END) AS long_leave,
                SUM(CASE WHEN status = 'Sick' THEN 1 ELSE 0 END) AS sick
            FROM attendance_records
            WHERE attendance_date = ?
        `, [selectedDate || todayString]);

        return res.json({
            success: true,
            month,
            selected_date: selectedDate || todayString,
            employees,
            records,
            day_summary: {
                total: Number(dayRows[0]?.total || 0),
                present: Number(dayRows[0]?.present || 0),
                absent: Number(dayRows[0]?.absent || 0),
                leave: Number(dayRows[0]?.leave_count || 0),
                long_leave: Number(dayRows[0]?.long_leave || 0),
                sick: Number(dayRows[0]?.sick || 0)
            }
        });
    } catch (error) {
        console.error("MONTHLY ATTENDANCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "تعذر تحميل كشف الحضور الشهري",
            error: error.message
        });
    }
});

// =====================================================
// GET ATTENDANCE RECORDS
// =====================================================

app.get(
    "/api/attendance",
    async (req, res) => {

        try {

            const month =
                cleanString(
                    req.query.month
                );

            const date =
                cleanString(
                    req.query.date
                );

            let sql = `

                SELECT

                    ar.*,

                    e.employee_code,
                    e.full_name,
                    e.job_title,
                    e.department

                FROM attendance_records ar

                INNER JOIN employees e

                    ON e.id =
                       ar.employee_id

            `;

            const conditions = [];

            const params = [];

            if (month) {

                conditions.push(`

                    DATE_FORMAT(
                        ar.attendance_date,
                        '%Y-%m'
                    ) = ?

                `);

                params.push(month);

            }

            if (date) {

                conditions.push(`

                    ar.attendance_date = ?

                `);

                params.push(date);

            }

            if (
                conditions.length > 0
            ) {

                sql += `

                    WHERE

                    ${conditions.join(
                        " AND "
                    )}

                `;

            }

            sql += `

                ORDER BY

                    ar.attendance_date DESC,

                    e.full_name ASC

            `;

            const [rows] =
                await db.query(
                    sql,
                    params
                );

            return res.json({

                success: true,

                count:
                    rows.length,

                records:
                    rows

            });

        } catch (error) {

            console.error(
                "GET ATTENDANCE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب الحضور والانصراف",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// ATTENDANCE SUMMARY
// =====================================================

app.get(
    "/api/attendance/stats/summary",
    async (req, res) => {

        try {

            const month =
                cleanString(
                    req.query.month
                );

            if (!month) {

                return res.status(400).json({

                    success: false,

                    message:
                        "يجب تحديد الشهر"

                });

            }

            const [rows] =
                await db.query(`

                    SELECT

                        COUNT(*) AS total_records,

                        SUM(
                            CASE
                                WHEN status = 'Present'
                                THEN 1
                                ELSE 0
                            END
                        ) AS present_count,

                        SUM(
                            CASE
                                WHEN status = 'Absent'
                                THEN 1
                                ELSE 0
                            END
                        ) AS absent_count,

                        SUM(
                            CASE
                                WHEN status = 'Late'
                                THEN 1
                                ELSE 0
                            END
                        ) AS late_count,

                        SUM(
                            CASE
                                WHEN status = 'Leave'
                                THEN 1
                                ELSE 0
                            END
                        ) AS leave_count,

                        SUM(
                            CASE
                                WHEN status = 'Off'
                                THEN 1
                                ELSE 0
                            END
                        ) AS off_count

                    FROM attendance_records

                    WHERE

                        DATE_FORMAT(
                            attendance_date,
                            '%Y-%m'
                        ) = ?

                `, [month]);

            const summary =
                rows[0] || {};

            return res.json({

                success: true,

                month,

                total_records:
                    Number(
                        summary.total_records || 0
                    ),

                present:
                    Number(
                        summary.present_count || 0
                    ),

                absent:
                    Number(
                        summary.absent_count || 0
                    ),

                late:
                    Number(
                        summary.late_count || 0
                    ),

                leave:
                    Number(
                        summary.leave_count || 0
                    ),

                off:
                    Number(
                        summary.off_count || 0
                    )

            });

        } catch (error) {

            console.error(
                "ATTENDANCE SUMMARY ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب إحصائيات الحضور",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// GET ATTENDANCE BY ID
// =====================================================

app.get(
    "/api/attendance/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم السجل غير صحيح"

                });

            }

            const [rows] =
                await db.query(`

                    SELECT

                        ar.*,

                        e.employee_code,
                        e.full_name,
                        e.job_title

                    FROM attendance_records ar

                    INNER JOIN employees e

                        ON e.id =
                           ar.employee_id

                    WHERE

                        ar.id = ?

                `, [id]);

            if (
                rows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "سجل الحضور غير موجود"

                });

            }

            return res.json({

                success: true,

                record:
                    rows[0]

            });

        } catch (error) {

            console.error(
                "GET ATTENDANCE BY ID ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء جلب سجل الحضور",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// CREATE / UPSERT ATTENDANCE
// =====================================================

app.post(
    "/api/attendance",
    async (req, res) => {

        try {

            const {

                employee_id,
                attendance_date,
                check_in,
                check_out,
                status,
                notes

            } = req.body;

            const employeeId =
                Number(employee_id);

            if (!employeeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "الموظف مطلوب"

                });

            }

            if (!attendance_date) {

                return res.status(400).json({

                    success: false,

                    message:
                        "تاريخ الحضور مطلوب"

                });

            }

            const validStatuses = [

                "Present",
                "Absent",
                "Late",
                "Leave",
                "Off",
                "Sick"

            ];

            const attendanceStatus =

                validStatuses.includes(status)

                    ? status

                    : "Present";

            const [employeeRows] =
                await db.query(`

                    SELECT id

                    FROM employees

                    WHERE id = ?

                `, [employeeId]);

            if (
                employeeRows.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "الموظف غير موجود"

                });

            }

            const [existingRows] =
                await db.query(`

                    SELECT id

                    FROM attendance_records

                    WHERE

                        employee_id = ?

                        AND attendance_date = ?

                    LIMIT 1

                `, [

                    employeeId,
                    attendance_date

                ]);

            if (
                existingRows.length > 0
            ) {

                const recordId =
                    existingRows[0].id;

                await db.query(`

                    UPDATE attendance_records

                    SET

                        check_in = ?,
                        check_out = ?,
                        status = ?,
                        notes = ?

                    WHERE id = ?

                `, [

                    check_in || null,
                    check_out || null,
                    attendanceStatus,
                    cleanString(notes),
                    recordId

                ]);

                return res.json({

                    success: true,

                    message:
                        "تم تحديث سجل الحضور",

                    record_id:
                        recordId

                });

            }

            const [result] =
                await db.query(`

                    INSERT INTO attendance_records
                    (

                        employee_id,
                        attendance_date,
                        check_in,
                        check_out,
                        status,
                        notes

                    )

                    VALUES
                    (

                        ?, ?, ?, ?, ?, ?

                    )

                `, [

                    employeeId,
                    attendance_date,
                    check_in || null,
                    check_out || null,
                    attendanceStatus,
                    cleanString(notes)

                ]);

            return res.status(201).json({

                success: true,

                message:
                    "تم تسجيل الحضور بنجاح",

                record_id:
                    result.insertId

            });

        } catch (error) {

            console.error(
                "CREATE ATTENDANCE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء حفظ الحضور",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// UPDATE ATTENDANCE
// =====================================================

app.put(
    "/api/attendance/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم السجل غير صحيح"

                });

            }

            const {

                employee_id,
                attendance_date,
                check_in,
                check_out,
                status,
                notes

            } = req.body;

            const employeeId =
                Number(employee_id);

            if (!employeeId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "الموظف مطلوب"

                });

            }

            if (!attendance_date) {

                return res.status(400).json({

                    success: false,

                    message:
                        "التاريخ مطلوب"

                });

            }

            const validStatuses = [

                "Present",
                "Absent",
                "Late",
                "Leave",
                "Off",
                "Sick"

            ];

            const attendanceStatus =

                validStatuses.includes(status)

                    ? status

                    : "Present";

            const [duplicateRows] =
                await db.query(`

                    SELECT id

                    FROM attendance_records

                    WHERE

                        employee_id = ?

                        AND attendance_date = ?

                        AND id <> ?

                    LIMIT 1

                `, [

                    employeeId,
                    attendance_date,
                    id

                ]);

            if (
                duplicateRows.length > 0
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        "يوجد بالفعل سجل لهذا الموظف في نفس التاريخ"

                });

            }

            const [result] =
                await db.query(`

                    UPDATE attendance_records

                    SET

                        employee_id = ?,
                        attendance_date = ?,
                        check_in = ?,
                        check_out = ?,
                        status = ?,
                        notes = ?

                    WHERE id = ?

                `, [

                    employeeId,
                    attendance_date,
                    check_in || null,
                    check_out || null,
                    attendanceStatus,
                    cleanString(notes),
                    id

                ]);

            if (
                result.affectedRows === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "سجل الحضور غير موجود"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم تعديل سجل الحضور"

            });

        } catch (error) {

            console.error(
                "UPDATE ATTENDANCE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء تعديل الحضور",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// DELETE ATTENDANCE
// =====================================================

app.delete(
    "/api/attendance/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (!id) {

                return res.status(400).json({

                    success: false,

                    message:
                        "رقم السجل غير صحيح"

                });

            }

            const [result] =
                await db.query(`

                    DELETE FROM attendance_records

                    WHERE id = ?

                `, [id]);

            if (
                result.affectedRows === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "سجل الحضور غير موجود"

                });

            }

            return res.json({

                success: true,

                message:
                    "تم حذف سجل الحضور"

            });

        } catch (error) {

            console.error(
                "DELETE ATTENDANCE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "حدث خطأ أثناء حذف الحضور",

                error:
                    error.message

            });

        }

    }
);

// =====================================================
// DASHBOARD SUMMARY API
// =====================================================

app.get("/api/dashboard/summary", async (req, res) => {
    try {
        // Dashboard totals are intentionally calculated from the live database.
        // Existing tables are detected first so the dashboard stays compatible
        // with older IBuild databases and with newer modules.
        const [tableRows] = await db.query(`
            SELECT TABLE_NAME
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
        `);
        const tables = new Set(tableRows.map(row => row.TABLE_NAME));

        const has = (name) => tables.has(name);

        const result = {
            employees: 0,
            active_employees: 0,
            attendance_today: 0,
            active_projects: 0,
            total_projects: 0,
            contract_value: 0,
            invoice_count: 0,
            invoice_total: 0,
            invoice_paid: 0,
            invoice_outstanding: 0,
            payment_count: 0,
            paid_amount: 0,
            payments_total: 0,
            payments_remaining: 0,
            payments_due: 0,
            payments_remaining_count: 0,
            payments_due_count: 0,
            payments_summary: [],
            project_expenses: 0,
            estimated_profit: 0,
            payroll_month_total: 0,
            payroll_records: 0,
            leave_requests: 0,
            pending_leaves: 0,
            users: 0,
            projects_summary: []
        };

        if (has("employees")) {
            const [rows] = await db.query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE
                        WHEN employment_status = 'Active' AND status = 'active'
                        THEN 1 ELSE 0 END) AS active
                FROM employees
            `);
            result.employees = Number(rows[0]?.total || 0);
            result.active_employees = Number(rows[0]?.active || 0);
        }

        if (has("attendance_records")) {
            const [rows] = await db.query(`
                SELECT COUNT(*) AS total
                FROM attendance_records
                WHERE attendance_date = CURDATE()
                  AND status IN ('Present','Late')
            `);
            result.attendance_today = Number(rows[0]?.total || 0);
        } else if (has("attendance")) {
            const [rows] = await db.query(`
                SELECT COUNT(*) AS total
                FROM attendance
                WHERE attendance_date = CURDATE()
                  AND status IN ('Present','Late')
            `);
            result.attendance_today = Number(rows[0]?.total || 0);
        }

        if (has("projects")) {
            const [rows] = await db.query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS active,
                    COALESCE(SUM(contract_value),0) AS contract_value
                FROM projects
            `);
            result.total_projects = Number(rows[0]?.total || 0);
            result.active_projects = Number(rows[0]?.active || 0);
            result.contract_value = Number(rows[0]?.contract_value || 0);

            const [projectRows] = await db.query(`
                SELECT
                    p.id,
                    p.project_name,
                    p.client_name,
                    COALESCE(p.contract_value,0) AS contract_value,
                    COALESCE(p.progress_percentage,0) AS progress_percentage,
                    p.status,
                    COALESCE((
                        SELECT SUM(i.total_amount)
                        FROM invoices i
                        WHERE i.project_id = p.id
                    ),0) AS invoiced_total,
                    COALESCE((
                        SELECT SUM(pay.amount)
                        FROM payments pay
                        WHERE pay.project_id = p.id
                          AND pay.status IN ('Completed','Paid')
                    ),0) AS collected_total,
                    COALESCE((
                        SELECT SUM(pay.amount)
                        FROM payments pay
                        WHERE pay.project_id = p.id
                          AND pay.status NOT IN ('Completed','Paid','Rejected')
                    ),0) AS payment_remaining,
                    COALESCE((
                        SELECT SUM(pay.amount)
                        FROM payments pay
                        WHERE pay.project_id = p.id
                          AND pay.status NOT IN ('Completed','Paid','Rejected')
                          AND pay.due_date IS NOT NULL
                          AND pay.due_date <= CURDATE()
                    ),0) AS payment_due,
                    COALESCE((
                        SELECT SUM(pe.amount)
                        FROM project_expenses pe
                        WHERE pe.project_id = p.id
                    ),0) AS total_expenses
                FROM projects p
                ORDER BY p.id DESC
            `);

            result.projects_summary = projectRows.map(row => {
                const contract = Number(row.contract_value || 0);
                const invoiced = Number(row.invoiced_total || 0);
                const collected = Number(row.collected_total || 0);
                const paymentRemaining = Number(row.payment_remaining || 0);
                const paymentDue = Number(row.payment_due || 0);
                const expenses = Number(row.total_expenses || 0);
                return {
                    id: Number(row.id),
                    project_name: row.project_name,
                    client_name: row.client_name,
                    status: row.status,
                    progress_percentage: Number(row.progress_percentage || 0),
                    contract_value: contract,
                    invoiced_total: invoiced,
                    collected_total: collected,
                    payment_remaining: paymentRemaining,
                    payment_due: paymentDue,
                    outstanding: paymentRemaining,
                    total_expenses: expenses,
                    estimated_profit: contract - expenses
                };
            });
        }

        if (has("invoices")) {
            const [rows] = await db.query(`
                SELECT
                    COUNT(*) AS count,
                    COALESCE(SUM(total_amount),0) AS total
                FROM invoices
            `);
            result.invoice_count = Number(rows[0]?.count || 0);
            result.invoice_total = Number(rows[0]?.total || 0);

            const [paidRows] = await db.query(`
                SELECT COALESCE(SUM(pay.amount),0) AS total
                FROM payments pay
                WHERE pay.status IN ('Completed','Paid')
            `);
            result.invoice_paid = Number(paidRows[0]?.total || 0);
            result.invoice_outstanding = Math.max(
                result.invoice_total - result.invoice_paid,
                0
            );
        }

        if (has("payments")) {
            // Total = all registered payments except rejected.
            // Remaining = registered but not yet paid.
            // Due = unpaid payments whose due date has arrived.
            const [rows] = await db.query(`
                SELECT
                    COUNT(*) AS count,
                    COALESCE(SUM(
                        CASE WHEN status <> 'Rejected' THEN amount ELSE 0 END
                    ),0) AS total_registered,
                    COALESCE(SUM(
                        CASE WHEN status IN ('Completed','Paid') THEN amount ELSE 0 END
                    ),0) AS total_paid,
                    COALESCE(SUM(
                        CASE
                            WHEN status NOT IN ('Completed','Paid','Rejected') THEN amount
                            ELSE 0
                        END
                    ),0) AS total_remaining,
                    COALESCE(SUM(
                        CASE
                            WHEN status NOT IN ('Completed','Paid','Rejected')
                                 AND due_date IS NOT NULL
                                 AND due_date <= CURDATE()
                            THEN amount
                            ELSE 0
                        END
                    ),0) AS total_due,
                    COALESCE(SUM(
                        CASE
                            WHEN status NOT IN ('Completed','Paid','Rejected') THEN 1 ELSE 0
                        END
                    ),0) AS remaining_count,
                    COALESCE(SUM(
                        CASE
                            WHEN status NOT IN ('Completed','Paid','Rejected')
                                 AND due_date IS NOT NULL
                                 AND due_date <= CURDATE()
                            THEN 1 ELSE 0
                        END
                    ),0) AS due_count
                FROM payments
            `);

            result.payment_count = Number(rows[0]?.count || 0);
            result.paid_amount = Number(rows[0]?.total_paid || 0);
            result.payments_total = Number(rows[0]?.total_registered || 0);
            result.payments_remaining = Number(rows[0]?.total_remaining || 0);
            result.payments_due = Number(rows[0]?.total_due || 0);
            result.payments_remaining_count = Number(rows[0]?.remaining_count || 0);
            result.payments_due_count = Number(rows[0]?.due_count || 0);

            if (has("projects")) {
                const [paymentProjectRows] = await db.query(`
                    SELECT
                        p.id AS project_id,
                        p.project_name,
                        COUNT(pay.id) AS payment_count,
                        COALESCE(SUM(
                            CASE WHEN pay.status <> 'Rejected' THEN pay.amount ELSE 0 END
                        ),0) AS total_payments,
                        COALESCE(SUM(
                            CASE
                                WHEN pay.status NOT IN ('Completed','Paid','Rejected') THEN pay.amount
                                ELSE 0
                            END
                        ),0) AS remaining_payments,
                        COALESCE(SUM(
                            CASE
                                WHEN pay.status NOT IN ('Completed','Paid','Rejected')
                                     AND pay.due_date IS NOT NULL
                                     AND pay.due_date <= CURDATE()
                                THEN pay.amount
                                ELSE 0
                            END
                        ),0) AS due_payments
                    FROM projects p
                    LEFT JOIN payments pay ON pay.project_id = p.id
                    GROUP BY p.id, p.project_name
                    ORDER BY p.id DESC
                `);

                result.payments_summary = paymentProjectRows.map(row => ({
                    project_id: Number(row.project_id),
                    project_name: row.project_name,
                    payment_count: Number(row.payment_count || 0),
                    total_payments: Number(row.total_payments || 0),
                    remaining_payments: Number(row.remaining_payments || 0),
                    due_payments: Number(row.due_payments || 0)
                }));
            }
        }

        if (has("project_expenses")) {
            const [rows] = await db.query(`
                SELECT COALESCE(SUM(amount),0) AS total
                FROM project_expenses
            `);
            result.project_expenses = Number(rows[0]?.total || 0);
        }

        result.estimated_profit =
            result.contract_value - result.project_expenses;

        if (has("payroll_records")) {
            const [rows] = await db.query(`
                SELECT
                    COUNT(*) AS records,
                    COALESCE(SUM(net_salary),0) AS total
                FROM payroll_records
                WHERE payroll_month >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                  AND payroll_month < DATE_ADD(
                      DATE_FORMAT(CURDATE(), '%Y-%m-01'),
                      INTERVAL 1 MONTH
                  )
            `);
            result.payroll_records = Number(rows[0]?.records || 0);
            result.payroll_month_total = Number(rows[0]?.total || 0);
        }

        if (has("leave_requests")) {
            const [rows] = await db.query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending
                FROM leave_requests
            `);
            result.leave_requests = Number(rows[0]?.total || 0);
            result.pending_leaves = Number(rows[0]?.pending || 0);
        }

        if (has("users")) {
            const [rows] = await db.query(`
                SELECT COUNT(*) AS total
                FROM users
                WHERE is_active = 1
            `);
            result.users = Number(rows[0]?.total || 0);
        }

        return res.json({
            success: true,
            ...result,
            paid_amount: money(result.paid_amount),
            payments_total: money(result.payments_total),
            payments_remaining: money(result.payments_remaining),
            payments_due: money(result.payments_due),
            contract_value: money(result.contract_value),
            invoice_total: money(result.invoice_total),
            invoice_paid: money(result.invoice_paid),
            invoice_outstanding: money(result.invoice_outstanding),
            project_expenses: money(result.project_expenses),
            estimated_profit: money(result.estimated_profit),
            payroll_month_total: money(result.payroll_month_total),
            projects_summary: result.projects_summary.map(project => ({
                ...project,
                contract_value: money(project.contract_value),
                invoiced_total: money(project.invoiced_total),
                collected_total: money(project.collected_total),
                payment_remaining: money(project.payment_remaining),
                payment_due: money(project.payment_due),
                outstanding: money(project.outstanding),
                total_expenses: money(project.total_expenses),
                estimated_profit: money(project.estimated_profit)
            })),
            payments_summary: result.payments_summary.map(project => ({
                ...project,
                total_payments: money(project.total_payments),
                remaining_payments: money(project.remaining_payments),
                due_payments: money(project.due_payments)
            }))
        });
    } catch (error) {
        console.error("DASHBOARD SUMMARY ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "حدث خطأ أثناء جلب ملخص لوحة التحكم",
            error: error.message
        });
    }
});

// =====================================================
// REPORTS API
// =====================================================
// =====================================================

app.get("/api/reports/summary", async (req, res) => {
    try {
        const month = cleanString(req.query.month) || new Date().toISOString().slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, message: "صيغة الشهر غير صحيحة" });
        }

        const [employees] = await db.query(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN employment_status='Active' AND status='active' THEN 1 ELSE 0 END) AS active,
                   COALESCE(SUM(CASE WHEN employment_status='Active' AND status='active' THEN payroll_salary ELSE 0 END),0) AS salary_total
            FROM employees
        `);

        const [projects] = await db.query(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) AS active,
                   SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) AS completed,
                   COALESCE(SUM(contract_value),0) AS contract_total
            FROM projects
        `);

        const [projectFinance] = await db.query(`
            SELECT
                COALESCE(SUM(p.contract_value),0) AS contract_value,
                COALESCE((SELECT SUM(pe.amount) FROM project_expenses pe),0) AS total_expenses,
                COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.status='Paid'),0) AS collected_total
            FROM projects p
        `);

        const financeContract = money(projectFinance[0]?.contract_value);
        const financeCosts = money(projectFinance[0]?.total_expenses);
        const financeCollected = money(projectFinance[0]?.collected_total);
        const financeProfit = financeContract - financeCosts;

        const [invoices] = await db.query(`
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(invoice_amount),0) AS subtotal,
                   COALESCE(SUM(vat_amount),0) AS vat,
                   COALESCE(SUM(total_amount),0) AS total_amount,
                   COALESCE(SUM(CASE WHEN status='Paid' THEN total_amount ELSE 0 END),0) AS paid_total,
                   COALESCE(SUM(CASE WHEN status<>'Paid' THEN total_amount ELSE 0 END),0) AS outstanding
            FROM invoices
            WHERE DATE_FORMAT(invoice_date,'%Y-%m') = ?
        `, [month]);

        const [payments] = await db.query(`
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(amount),0) AS total_amount,
                   COALESCE(SUM(CASE WHEN status='Paid' THEN amount ELSE 0 END),0) AS paid_total,
                   COALESCE(SUM(CASE WHEN status<>'Paid' THEN amount ELSE 0 END),0) AS pending_total
            FROM payments
            WHERE DATE_FORMAT(COALESCE(received_date, submitted_date, created_at),'%Y-%m') = ?
        `, [month]);

        const [payroll] = await db.query(`
            SELECT COUNT(*) AS records,
                   COALESCE(SUM(payroll_salary),0) AS salary,
                   COALESCE(SUM(overtime_amount),0) AS overtime,
                   COALESCE(SUM(additions),0) AS additions,
                   COALESCE(SUM(absence_deduction),0) AS absence_deduction,
                   COALESCE(SUM(deductions),0) AS deductions,
                   COALESCE(SUM(net_salary),0) AS net_salary
            FROM payroll_records
            WHERE DATE_FORMAT(payroll_month, '%Y-%m') = ?
        `, [month]);

        const [attendance] = await db.query(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status='Present' THEN 1 ELSE 0 END) AS present,
                   SUM(CASE WHEN status='Absent' THEN 1 ELSE 0 END) AS absent,
                   SUM(CASE WHEN status='Late' THEN 1 ELSE 0 END) AS late,
                   SUM(CASE WHEN status='Leave' THEN 1 ELSE 0 END) AS leave_days,
                   SUM(CASE WHEN status='Off' THEN 1 ELSE 0 END) AS off_days
            FROM attendance_records
            WHERE DATE_FORMAT(attendance_date,'%Y-%m') = ?
        `, [month]);

        return res.json({
            success: true,
            month,
            employees: {
                total: Number(employees[0]?.total || 0),
                active: Number(employees[0]?.active || 0),
                salary_total: money(employees[0]?.salary_total)
            },
            projects: {
                total: Number(projects[0]?.total || 0),
                active: Number(projects[0]?.active || 0),
                completed: Number(projects[0]?.completed || 0),
                contract_total: money(projects[0]?.contract_total),
                finance_contract_value: financeContract,
                total_expenses: financeCosts,
                collected_total: financeCollected,
                gross_profit: financeProfit,
                gross_margin_percentage: financeContract > 0 ? Number(((financeProfit / financeContract) * 100).toFixed(2)) : 0
            },
            invoices: {
                total: Number(invoices[0]?.total || 0),
                subtotal: money(invoices[0]?.subtotal),
                vat: money(invoices[0]?.vat),
                total_amount: money(invoices[0]?.total_amount),
                paid_total: money(invoices[0]?.paid_total),
                outstanding: money(invoices[0]?.outstanding)
            },
            payments: {
                total: Number(payments[0]?.total || 0),
                total_amount: money(payments[0]?.total_amount),
                paid_total: money(payments[0]?.paid_total),
                pending_total: money(payments[0]?.pending_total)
            },
            payroll: {
                records: Number(payroll[0]?.records || 0),
                salary: money(payroll[0]?.salary),
                overtime: money(payroll[0]?.overtime),
                additions: money(payroll[0]?.additions),
                absence_deduction: money(payroll[0]?.absence_deduction),
                deductions: money(payroll[0]?.deductions),
                net_salary: money(payroll[0]?.net_salary)
            },
            attendance: {
                total: Number(attendance[0]?.total || 0),
                present: Number(attendance[0]?.present || 0),
                absent: Number(attendance[0]?.absent || 0),
                late: Number(attendance[0]?.late || 0),
                leave: Number(attendance[0]?.leave_days || 0),
                off: Number(attendance[0]?.off_days || 0)
            }
        });
    } catch (error) {
        console.error("REPORTS SUMMARY ERROR:", error);
        return res.status(500).json({ success: false, message: "حدث خطأ أثناء إنشاء التقرير", error: error.message });
    }
});

// =====================================================
// LEAVES API
// =====================================================

app.get('/api/leaves', requirePermission('leaves.view'), async (req,res)=>{
    try {
        const [rows] = await db.query(`SELECT l.*, e.employee_code, e.full_name FROM leave_requests l INNER JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC`);
        return res.json({success:true,count:rows.length,leaves:rows});
    } catch(error){ console.error('GET LEAVES ERROR:',error); return res.status(500).json({success:false,message:'حدث خطأ أثناء جلب الإجازات',error:error.message}); }
});

app.get('/api/leaves/balance/:employeeId', requirePermission('leaves.view'), async (req,res)=>{
    try {
        const employeeId=Number(req.params.employeeId); if(!employeeId) return res.status(400).json({success:false,message:'رقم الموظف غير صحيح'});
        const [emp]=await db.query(`SELECT id,full_name,annual_leave_days,joining_date,hire_date FROM employees WHERE id=? LIMIT 1`,[employeeId]);
        if(!emp.length) return res.status(404).json({success:false,message:'الموظف غير موجود'});
        const [used]=await db.query(`SELECT COALESCE(SUM(days),0) AS used_days FROM leave_requests WHERE employee_id=? AND status='Approved' AND leave_type='Annual'`,[employeeId]);
        const entitlement=Number(emp[0].annual_leave_days||30); const usedDays=Number(used[0]?.used_days||0);
        return res.json({success:true,employee:emp[0],entitlement,used_days:usedDays,balance:Math.max(entitlement-usedDays,0)});
    } catch(error){return res.status(500).json({success:false,message:'حدث خطأ أثناء حساب رصيد الإجازة',error:error.message});}
});

app.post('/api/leaves', requirePermission('leaves.write'), async (req,res)=>{
    try{
        const employeeId=Number(req.body.employee_id); const start=cleanString(req.body.start_date); const end=cleanString(req.body.end_date); const type=cleanString(req.body.leave_type)||'Annual'; const reason=cleanString(req.body.reason);
        if(!employeeId||!start||!end) return res.status(400).json({success:false,message:'الموظف وتاريخ البداية والنهاية مطلوبون'});
        if(start>end) return res.status(400).json({success:false,message:'تاريخ النهاية يجب أن يكون بعد البداية'});
        const days=Math.max(1, Math.floor((new Date(end+'T00:00:00')-new Date(start+'T00:00:00'))/86400000)+1);
        const [r]=await db.query(`INSERT INTO leave_requests (employee_id,leave_type,start_date,end_date,days,status,reason) VALUES (?,?,?,?,?,'Pending',?)`,[employeeId,type,start,end,days,reason]);
        await audit(req,'CREATE','leave_requests',r.insertId,{employee_id:employeeId,days});
        return res.status(201).json({success:true,message:'تم تسجيل طلب الإجازة',leave_id:r.insertId,days});
    }catch(error){return res.status(500).json({success:false,message:'حدث خطأ أثناء تسجيل الإجازة',error:error.message});}
});

app.put('/api/leaves/:id/status', requirePermission('leaves.write'), async (req,res)=>{
    try{const id=Number(req.params.id); const status=String(req.body.status||''); if(!['Approved','Rejected','Cancelled','Pending'].includes(status)) return res.status(400).json({success:false,message:'حالة الإجازة غير صحيحة'}); const [r]=await db.query(`UPDATE leave_requests SET status=?,approved_by=?,approved_at=CASE WHEN ?='Approved' THEN NOW() ELSE approved_at END WHERE id=?`,[status,Number(req.user.sub)||null,status,id]); if(!r.affectedRows)return res.status(404).json({success:false,message:'طلب الإجازة غير موجود'}); await audit(req,'STATUS','leave_requests',id,{status}); return res.json({success:true,message:'تم تحديث حالة الإجازة'});}catch(error){return res.status(500).json({success:false,message:'حدث خطأ أثناء تحديث الإجازة',error:error.message});}
});

// =====================================================
// END OF SERVICE API
// =====================================================

app.get('/api/eos/:employeeId', requirePermission('eos.view'), async (req,res)=>{
    try{
        const employeeId=Number(req.params.employeeId); const [rows]=await db.query(`SELECT id,full_name,basic_salary,joining_date,hire_date,contract_end_date,status,employment_status FROM employees WHERE id=? LIMIT 1`,[employeeId]);
        if(!rows.length)return res.status(404).json({success:false,message:'الموظف غير موجود'});
        const e=rows[0]; const startRaw=e.joining_date||e.hire_date; if(!startRaw)return res.json({success:true,employee:e,service:{years:0,months:0,days:0,total_days:0},calculation:{basic_salary:money(e.basic_salary),eligible_days:0,amount:0,note:'لا يوجد تاريخ تعيين'} });
        const start=new Date(String(startRaw).slice(0,10)+'T00:00:00'); const end=new Date();
        let years=end.getFullYear()-start.getFullYear(); let months=end.getMonth()-start.getMonth(); let days=end.getDate()-start.getDate(); if(days<0){months--; const prev=new Date(end.getFullYear(),end.getMonth(),0); days+=prev.getDate();} if(months<0){years--;months+=12;}
        const totalDays=Math.floor((end-start)/86400000); const basic=money(e.basic_salary); const first=21, later=30; const eligibleDays=Math.min(totalDays,365)*first/365 + Math.max(totalDays-365,0)*later/365; const amount=basic/30*eligibleDays;
        return res.json({success:true,employee:e,service:{years,months,days,total_days:totalDays},calculation:{basic_salary:basic,eligible_days:Number(eligibleDays.toFixed(2)),amount:Number(amount.toFixed(2)),formula:'21 days per year for first year, then 30 days per year; prorated by days',note:'هذا حساب تقديري داخل النظام ويحتاج مراجعة حسب العقد والقانون المطبق'} });
    }catch(error){return res.status(500).json({success:false,message:'حدث خطأ أثناء حساب نهاية الخدمة',error:error.message});}
});

// =====================================================
// EMPLOYEE DOCUMENTS API
// =====================================================
app.get('/api/employees/:id/documents', requirePermission('employees.view'), async (req,res)=>{try{const id=Number(req.params.id);const [rows]=await db.query(`SELECT * FROM employee_documents WHERE employee_id=? ORDER BY expiry_date IS NULL, expiry_date ASC, id DESC`,[id]);return res.json({success:true,documents:rows});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء جلب مستندات الموظف',error:e.message});}});
app.post('/api/employees/:id/documents', requirePermission('employees.write'), async (req,res)=>{try{const id=Number(req.params.id);const type=cleanString(req.body.document_type);if(!id||!type)return res.status(400).json({success:false,message:'الموظف ونوع المستند مطلوبان'});const [r]=await db.query(`INSERT INTO employee_documents(employee_id,document_type,document_number,issue_date,expiry_date,notes) VALUES(?,?,?,?,?,?)`,[id,type,cleanString(req.body.document_number),req.body.issue_date||null,req.body.expiry_date||null,cleanString(req.body.notes)]);await audit(req,'CREATE','employee_documents',r.insertId,{employee_id:id,document_type:type});return res.status(201).json({success:true,document_id:r.insertId});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء حفظ المستند',error:e.message});}});
app.delete('/api/employees/:employeeId/documents/:id', requirePermission('employees.write'), async (req,res)=>{try{const [r]=await db.query(`DELETE FROM employee_documents WHERE id=? AND employee_id=?`,[Number(req.params.id),Number(req.params.employeeId)]);if(!r.affectedRows)return res.status(404).json({success:false,message:'المستند غير موجود'});await audit(req,'DELETE','employee_documents',Number(req.params.id),{});return res.json({success:true,message:'تم حذف المستند'});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء حذف المستند',error:e.message});}});

// =====================================================
// USERS / ROLES API
// =====================================================
app.get('/api/users', requirePermission('users.manage'), async (req,res)=>{try{const [rows]=await db.query(`SELECT id,full_name,username,role,is_active,created_at,updated_at FROM users ORDER BY id DESC`);return res.json({success:true,users:rows});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء جلب المستخدمين',error:e.message});}});
app.post('/api/users', requirePermission('users.manage'), async (req,res)=>{try{const bcrypt=require('bcryptjs');const name=cleanString(req.body.full_name);const username=cleanString(req.body.username);const password=String(req.body.password||'');const role=['Admin','Manager','Accountant','HR','Viewer'].includes(req.body.role)?req.body.role:'Viewer';if(!name||!username||password.length<6)return res.status(400).json({success:false,message:'الاسم واسم المستخدم وكلمة مرور 6 أحرف على الأقل مطلوبة'});const [dup]=await db.query(`SELECT id FROM users WHERE username=? LIMIT 1`,[username]);if(dup.length)return res.status(409).json({success:false,message:'اسم المستخدم موجود بالفعل'});const hash=await bcrypt.hash(password,12);const [r]=await db.query(`INSERT INTO users(full_name,username,password_hash,role,is_active) VALUES(?,?,?,?,1)`,[name,username,hash,role]);await audit(req,'CREATE','users',r.insertId,{username,role});return res.status(201).json({success:true,user_id:r.insertId});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء إنشاء المستخدم',error:e.message});}});
app.put('/api/users/:id/status', requirePermission('users.manage'), async (req,res)=>{try{const id=Number(req.params.id);const active=req.body.is_active===false?0:1;const [r]=await db.query(`UPDATE users SET is_active=? WHERE id=?`,[active,id]);if(!r.affectedRows)return res.status(404).json({success:false,message:'المستخدم غير موجود'});await audit(req,'STATUS','users',id,{is_active:active});return res.json({success:true,message:'تم تحديث حالة المستخدم'});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء تحديث الحالة',error:e.message});}});
app.put('/api/users/:id', requirePermission('users.manage'), async (req,res)=>{try{const id=Number(req.params.id);const role=['Admin','Manager','Accountant','HR','Viewer'].includes(req.body.role)?req.body.role:null;if(!role)return res.status(400).json({success:false,message:'الدور غير صحيح'});const active=req.body.is_active===false?0:1;const [r]=await db.query(`UPDATE users SET full_name=?,role=?,is_active=? WHERE id=?`,[cleanString(req.body.full_name),role,active,id]);if(!r.affectedRows)return res.status(404).json({success:false,message:'المستخدم غير موجود'});if(req.body.password){const bcrypt=require('bcryptjs');if(String(req.body.password).length<6)return res.status(400).json({success:false,message:'كلمة المرور 8 أحرف على الأقل'});const hash=await bcrypt.hash(String(req.body.password),12);await db.query(`UPDATE users SET password_hash=? WHERE id=?`,[hash,id]);}await audit(req,'UPDATE','users',id,{role,is_active:active});return res.json({success:true,message:'تم تحديث المستخدم'});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء تحديث المستخدم',error:e.message});}});

app.get('/api/audit-logs', requirePermission('users.manage'), async (req,res)=>{try{const limit=Math.min(Math.max(Number(req.query.limit)||100,1),500);const [rows]=await db.query(`SELECT id,user_id,username,action,entity,entity_id,details,ip_address,created_at FROM audit_logs ORDER BY id DESC LIMIT ?`,[limit]);return res.json({success:true,logs:rows});}catch(e){return res.status(500).json({success:false,message:'حدث خطأ أثناء جلب سجل العمليات',error:e.message});}});


// =====================================================
// SYSTEM BACKUP / RESTORE
// =====================================================

app.get('/api/system/backup', requirePermission('system.backup'), async (req, res) => {
    try {
        const { backup, fileName } = await saveDatabaseBackup();
        await audit(req, 'BACKUP', 'database', null, {
            file_name: fileName,
            tables: backup.tables.length,
            views: backup.views.length
        });

        const payload = JSON.stringify(backup);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(payload);
    } catch (error) {
        console.error('DATABASE BACKUP ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية',
            error: error.message
        });
    }
});

app.get('/api/system/backups', requirePermission('system.backup'), async (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'database', 'backups');
        fs.mkdirSync(backupDir, { recursive: true });

        const files = fs.readdirSync(backupDir)
            .filter(name => /^ibuild-backup-.*\.json$/i.test(name))
            .map(name => {
                const filePath = path.join(backupDir, name);
                const stat = fs.statSync(filePath);
                return {
                    name,
                    size: stat.size,
                    created_at: stat.mtime.toISOString()
                };
            })
            .sort((a, b) => b.created_at.localeCompare(a.created_at));

        return res.json({ success: true, backups: files });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء جلب النسخ الاحتياطية',
            error: error.message
        });
    }
});

app.post('/api/system/restore', requirePermission('system.backup'), async (req, res) => {
    try {
        const backup = req.body?.backup;
        if (!backup) {
            return res.status(400).json({
                success: false,
                message: 'لم يتم إرسال ملف النسخة الاحتياطية'
            });
        }

        await restoreDatabaseBackup(backup);

        // Restore may replace audit_logs itself, so write the restore event after the transaction.
        await audit(req, 'RESTORE', 'database', null, {
            backup_created_at: backup.created_at || null,
            tables: Array.isArray(backup.tables) ? backup.tables.length : 0
        });

        return res.json({
            success: true,
            message: 'تم استعادة قاعدة البيانات بنجاح. سيتم تحديث الصفحة الآن.'
        });
    } catch (error) {
        console.error('DATABASE RESTORE ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'فشلت استعادة قاعدة البيانات ولم يتم إكمال العملية',
            error: error.message
        });
    }
});

app.post('/api/system/restore-latest', requirePermission('system.backup'), async (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'database', 'backups');
        fs.mkdirSync(backupDir, { recursive: true });

        const files = fs.readdirSync(backupDir)
            .filter(name => /^ibuild-backup-.*\.json$/i.test(name))
            .map(name => ({
                name,
                mtime: fs.statSync(path.join(backupDir, name)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

        if (!files.length) {
            return res.status(404).json({
                success: false,
                message: 'لا توجد نسخة احتياطية محفوظة على السيرفر'
            });
        }

        const latest = files[0];
        const backup = JSON.parse(
            fs.readFileSync(path.join(backupDir, latest.name), 'utf8')
        );

        await restoreDatabaseBackup(backup);
        await audit(req, 'RESTORE_LATEST', 'database', null, {
            file_name: latest.name,
            backup_created_at: backup.created_at || null
        });

        return res.json({
            success: true,
            message: `تم استعادة آخر نسخة احتياطية: ${latest.name}`
        });
    } catch (error) {
        console.error('RESTORE LATEST ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء استعادة آخر نسخة احتياطية',
            error: error.message
        });
    }
});


// =====================================================
// DETAIL / DOCUMENTS / PRINTABLE REPORTS
// =====================================================

function safeFileName(name) {
    return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
}

async function ensureDetailSchema() {
    const [docCols] = await db.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employee_documents'`);
    const existing = new Set(docCols.map(x => x.COLUMN_NAME));
    const additions = [
        ['original_name', 'VARCHAR(255) NULL'],
        ['stored_name', 'VARCHAR(255) NULL'],
        ['file_path', 'VARCHAR(500) NULL'],
        ['mime_type', 'VARCHAR(150) NULL'],
        ['file_size', 'BIGINT NULL']
    ];
    for (const [name, type] of additions) {
        if (!existing.has(name)) await db.query(`ALTER TABLE employee_documents ADD COLUMN ${name} ${type}`);
    }
    await db.query(`CREATE TABLE IF NOT EXISTS payment_documents (
        id INT NOT NULL AUTO_INCREMENT,
        payment_id INT NOT NULL,
        document_type VARCHAR(100) NOT NULL DEFAULT 'Attachment',
        original_name VARCHAR(255) NULL,
        stored_name VARCHAR(255) NULL,
        file_path VARCHAR(500) NULL,
        mime_type VARCHAR(150) NULL,
        file_size BIGINT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(id), KEY idx_payment_doc_payment(payment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

app.get('/api/employees/:id/full', requirePermission('employees.view'), async (req,res)=>{
    try {
        const id=Number(req.params.id); if(!id) return res.status(400).json({success:false,message:'رقم الموظف غير صحيح'});
        const [rows]=await db.query(`SELECT e.*, p.project_name FROM employees e LEFT JOIN projects p ON p.id=e.project_id WHERE e.id=? LIMIT 1`,[id]);
        if(!rows.length) return res.status(404).json({success:false,message:'الموظف غير موجود'});
        const [docs]=await db.query(`SELECT * FROM employee_documents WHERE employee_id=? ORDER BY expiry_date IS NULL, expiry_date ASC, id DESC`,[id]);
        const [attRows]=await db.query(`SELECT id,attendance_date,check_in,check_out,status,overtime_hours,notes FROM attendance WHERE employee_id=? ORDER BY attendance_date DESC`,[id]).catch(()=>[[]]);
        const [payroll]=await db.query(`SELECT payroll_month,payroll_salary,overtime_hours,overtime_amount,additions,absence_deduction,deductions,net_salary FROM payroll_records WHERE employee_id=? ORDER BY payroll_month DESC`,[id]).catch(()=>[[]]);
        const [leaves]=await db.query(`SELECT lr.id,lr.leave_type,lr.start_date,lr.end_date,lr.days,lr.status,lr.reason,lr.created_at,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('document_type',ld.document_type,'original_name',ld.original_name,'file_path',ld.file_path)) FROM leave_documents ld WHERE ld.leave_id=lr.id) AS attachments
            FROM leave_requests lr WHERE lr.employee_id=? ORDER BY lr.start_date DESC`,[id]).catch(()=>[[]]);
        const att = {total:attRows.length,present:attRows.filter(x=>x.status==='Present').length,absent:attRows.filter(x=>x.status==='Absent').length,sick:attRows.filter(x=>x.status==='Sick').length,leave_days:attRows.filter(x=>x.status==='Leave').length,off_days:attRows.filter(x=>x.status==='Off').length,late:attRows.filter(x=>x.status==='Late').length};
        return res.json({success:true,employee:rows[0],documents:docs,attendance:att,attendance_records:attRows,payroll,leaves});
    } catch(e){ console.error('EMPLOYEE FULL ERROR',e); return res.status(500).json({success:false,message:'حدث خطأ أثناء جلب ملف الموظف',error:e.message}); }
});

app.post('/api/employees/:id/documents/upload', requirePermission('employees.write'), async (req,res)=>{
    try {
        const employeeId=Number(req.params.id), type=cleanString(req.body.document_type)||'Attachment';
        const data=String(req.body.file_data||'');
        if(!employeeId || !data.includes(',')) return res.status(400).json({success:false,message:'الموظف والملف مطلوبان'});
        const [emp]=await db.query('SELECT id FROM employees WHERE id=? LIMIT 1',[employeeId]); if(!emp.length) return res.status(404).json({success:false,message:'الموظف غير موجود'});
        const match=data.match(/^data:([^;]+);base64,(.+)$/s); if(!match) return res.status(400).json({success:false,message:'صيغة الملف غير صحيحة'});
        const mime=match[1], buffer=Buffer.from(match[2],'base64');
        if(buffer.length>15*1024*1024) return res.status(400).json({success:false,message:'حجم الملف يجب ألا يتجاوز 15MB'});
        const original=safeFileName(req.body.original_name||'document');
        const ext=path.extname(original) || (mime==='application/pdf'?'.pdf':'');
        const stored=`emp_${employeeId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
        const dir=path.join(__dirname,'uploads','employees',String(employeeId)); fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,stored),buffer);
        const rel=`/uploads/employees/${employeeId}/${stored}`;
        const [r]=await db.query(`INSERT INTO employee_documents(employee_id,document_type,document_number,issue_date,expiry_date,notes,original_name,stored_name,file_path,mime_type,file_size) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[employeeId,type,cleanString(req.body.document_number),req.body.issue_date||null,req.body.expiry_date||null,cleanString(req.body.notes),original,stored,rel,mime,buffer.length]);
        await audit(req,'CREATE','employee_documents',r.insertId,{employee_id:employeeId,document_type:type,original_name:original});
        res.status(201).json({success:true,message:'تم رفع المستند بنجاح',document_id:r.insertId,file_path:rel});
    }catch(e){console.error('EMP DOC UPLOAD ERROR',e);res.status(500).json({success:false,message:'حدث خطأ أثناء رفع المستند',error:e.message});}
});

app.post('/api/leaves/:id/documents/upload', requirePermission('leaves.write'), async (req,res)=>{
    try {
        const leaveId=Number(req.params.id), data=String(req.body.file_data||'');
        if(!leaveId || !data.includes(',')) return res.status(400).json({success:false,message:'الإجازة والملف مطلوبان'});
        const [leave]=await db.query('SELECT id,employee_id FROM leave_requests WHERE id=? LIMIT 1',[leaveId]);
        if(!leave.length) return res.status(404).json({success:false,message:'الإجازة غير موجودة'});
        const match=data.match(/^data:([^;]+);base64,(.+)$/s); if(!match) return res.status(400).json({success:false,message:'صيغة الملف غير صحيحة'});
        const mime=match[1], buffer=Buffer.from(match[2],'base64'); if(buffer.length>15*1024*1024) return res.status(400).json({success:false,message:'حجم الملف يجب ألا يتجاوز 15MB'});
        const original=safeFileName(req.body.original_name||'leave_document'); const ext=path.extname(original);
        const stored=`leave_${leaveId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
        const dir=path.join(__dirname,'uploads','leaves',String(leaveId)); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,stored),buffer);
        const rel=`/uploads/leaves/${leaveId}/${stored}`;
        const [r]=await db.query(`INSERT INTO leave_documents(leave_id,document_type,original_name,stored_name,file_path,mime_type,file_size,notes) VALUES(?,?,?,?,?,?,?,?)`,[leaveId,cleanString(req.body.document_type)||'Attachment',original,stored,rel,mime,buffer.length,cleanString(req.body.notes)]);
        await audit(req,'CREATE','leave_documents',r.insertId,{leave_id:leaveId,document_type:req.body.document_type,original_name:original});
        res.status(201).json({success:true,message:'تم رفع المرفق بنجاح',document_id:r.insertId,file_path:rel});
    }catch(e){console.error('LEAVE DOC UPLOAD ERROR',e);res.status(500).json({success:false,message:'حدث خطأ أثناء رفع المرفق',error:e.message});}
});

app.get('/api/payments/:id/full', requirePermission('payments.view'), async (req,res)=>{
    try {
        const id=Number(req.params.id); if(!id) return res.status(400).json({success:false,message:'رقم الدفعة غير صحيح'});
        const [rows]=await db.query(`SELECT pay.*,p.project_name,p.client_name,p.contract_number,p.contract_value,inv.invoice_number,inv.invoice_date,inv.total_amount invoice_total FROM payments pay INNER JOIN projects p ON p.id=pay.project_id LEFT JOIN invoices inv ON inv.id=pay.invoice_id WHERE pay.id=? LIMIT 1`,[id]);
        if(!rows.length) return res.status(404).json({success:false,message:'الدفعة غير موجودة'});
        const [history]=await db.query(`SELECT * FROM payment_status_history WHERE payment_id=? ORDER BY id DESC`,[id]).catch(()=>[[]]);
        const [docs]=await db.query(`SELECT * FROM payment_documents WHERE payment_id=? ORDER BY id DESC`,[id]).catch(()=>[[]]);
        res.json({success:true,payment:rows[0],history,documents:docs});
    }catch(e){console.error('PAYMENT FULL ERROR',e);res.status(500).json({success:false,message:'حدث خطأ أثناء جلب تفاصيل الدفعة',error:e.message});}
});

app.post('/api/payments/:id/documents/upload', requirePermission('payments.write'), async (req,res)=>{
    try {
        const paymentId=Number(req.params.id), type=cleanString(req.body.document_type)||'Attachment', data=String(req.body.file_data||'');
        if(!paymentId || !data.includes(',')) return res.status(400).json({success:false,message:'الدفعة والملف مطلوبان'});
        const [pay]=await db.query('SELECT id FROM payments WHERE id=? LIMIT 1',[paymentId]); if(!pay.length) return res.status(404).json({success:false,message:'الدفعة غير موجودة'});
        const match=data.match(/^data:([^;]+);base64,(.+)$/s); if(!match) return res.status(400).json({success:false,message:'صيغة الملف غير صحيحة'});
        const mime=match[1], buffer=Buffer.from(match[2],'base64'); if(buffer.length>15*1024*1024) return res.status(400).json({success:false,message:'حجم الملف يجب ألا يتجاوز 15MB'});
        const original=safeFileName(req.body.original_name||'payment_document'); const ext=path.extname(original); const stored=`pay_${paymentId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
        const dir=path.join(__dirname,'uploads','payments',String(paymentId)); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,stored),buffer); const rel=`/uploads/payments/${paymentId}/${stored}`;
        const [r]=await db.query(`INSERT INTO payment_documents(payment_id,document_type,original_name,stored_name,file_path,mime_type,file_size,notes) VALUES(?,?,?,?,?,?,?,?)`,[paymentId,type,original,stored,rel,mime,buffer.length,cleanString(req.body.notes)]);
        await audit(req,'CREATE','payment_documents',r.insertId,{payment_id:paymentId,document_type:type,original_name:original});
        res.status(201).json({success:true,message:'تم رفع مرفق الدفعة بنجاح',document_id:r.insertId,file_path:rel});
    }catch(e){console.error('PAY DOC UPLOAD ERROR',e);res.status(500).json({success:false,message:'حدث خطأ أثناء رفع مرفق الدفعة',error:e.message});}
});

app.delete('/api/payments/:paymentId/documents/:id', requirePermission('payments.write'), async (req,res)=>{
    try{const paymentId=Number(req.params.paymentId),id=Number(req.params.id);const [rows]=await db.query('SELECT file_path FROM payment_documents WHERE id=? AND payment_id=?',[id,paymentId]);if(!rows.length)return res.status(404).json({success:false,message:'المرفق غير موجود'});const fp=rows[0].file_path;await db.query('DELETE FROM payment_documents WHERE id=? AND payment_id=?',[id,paymentId]);if(fp){const abs=path.join(__dirname,fp.replace(/^\//,''));if(fs.existsSync(abs))fs.unlinkSync(abs)}await audit(req,'DELETE','payment_documents',id,{payment_id:paymentId});res.json({success:true,message:'تم حذف المرفق'});}catch(e){res.status(500).json({success:false,message:'حدث خطأ أثناء حذف المرفق',error:e.message});}
});

app.get('/api/projects/:id/full', async (req,res)=>{
    try{const id=Number(req.params.id);const [rows]=await db.query('SELECT * FROM projects WHERE id=? LIMIT 1',[id]);if(!rows.length)return res.status(404).json({success:false,message:'المشروع غير موجود'});const [summary]=await db.query(`SELECT COALESCE((SELECT SUM(total_amount) FROM invoices WHERE project_id=?),0) invoice_total,COALESCE((SELECT SUM(amount) FROM payments WHERE project_id=? AND status='Paid'),0) paid_total,COALESCE((SELECT SUM(amount) FROM payments WHERE project_id=?),0) payment_total,COALESCE((SELECT SUM(amount) FROM project_expenses WHERE project_id=?),0) expense_total`,[id,id,id,id]);const [invoices]=await db.query(`SELECT id,invoice_number,invoice_date,total_amount,status FROM invoices WHERE project_id=? ORDER BY invoice_date DESC,id DESC`,[id]);const [payments]=await db.query(`SELECT id,payment_number,amount,submitted_date,received_date,status FROM payments WHERE project_id=? ORDER BY id DESC`,[id]);const [expenses]=await db.query('SELECT * FROM project_expenses WHERE project_id=? ORDER BY expense_date DESC,id DESC',[id]);res.json({success:true,project:rows[0],summary:summary[0],invoices,payments,expenses});}catch(e){res.status(500).json({success:false,message:'حدث خطأ أثناء جلب ملف المشروع',error:e.message});}
});

app.get('/api/invoices/:id/full', requirePermission('invoices.view'), async (req,res)=>{
    try{const id=Number(req.params.id);const [rows]=await db.query(`SELECT inv.*,p.project_name,p.client_name,p.contract_number,p.contract_value FROM invoices inv INNER JOIN projects p ON p.id=inv.project_id WHERE inv.id=? LIMIT 1`,[id]);if(!rows.length)return res.status(404).json({success:false,message:'الفاتورة غير موجودة'});const [payments]=await db.query('SELECT id,payment_number,amount,received_date,status FROM payments WHERE invoice_id=? ORDER BY id DESC',[id]);res.json({success:true,invoice:rows[0],payments});}catch(e){res.status(500).json({success:false,message:'حدث خطأ أثناء جلب تفاصيل الفاتورة',error:e.message});}
});

app.get('/api/reports/employees', requirePermission('reports.view'), async (req,res)=>{
    try{const status=cleanString(req.query.status);const [rows]=await db.query(`SELECT e.id,e.employee_code,e.full_name,e.nationality,e.job_title,e.department,e.phone,e.basic_salary,e.payroll_salary,e.hire_date,e.joining_date,e.contract_end_date,e.employment_status,e.status,p.project_name FROM employees e LEFT JOIN projects p ON p.id=e.project_id ${status?`WHERE e.status=? OR e.employment_status=?`:''} ORDER BY e.full_name`,status?[status,status]:[]);res.json({success:true,employees:rows});}catch(e){res.status(500).json({success:false,message:'حدث خطأ أثناء إنشاء تقرير الموظفين',error:e.message});}
});

app.get('/api/reports/payments', requirePermission('reports.view'), async (req,res)=>{
    try{const params=[];let where=[];if(req.query.from){where.push('COALESCE(pay.received_date,pay.submitted_date,DATE(pay.created_at))>=?');params.push(req.query.from)}if(req.query.to){where.push('COALESCE(pay.received_date,pay.submitted_date,DATE(pay.created_at))<=?');params.push(req.query.to)}if(req.query.status){where.push('pay.status=?');params.push(req.query.status)}if(req.query.project_id){where.push('pay.project_id=?');params.push(Number(req.query.project_id))}const [rows]=await db.query(`SELECT pay.id,pay.payment_number,pay.payment_type,pay.amount,pay.submitted_date,pay.approved_date,pay.due_date,pay.received_date,pay.status,p.project_name,p.client_name,inv.invoice_number FROM payments pay INNER JOIN projects p ON p.id=pay.project_id LEFT JOIN invoices inv ON inv.id=pay.invoice_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY COALESCE(pay.received_date,pay.submitted_date,pay.created_at) DESC,pay.id DESC`,params);const total=rows.reduce((a,x)=>a+Number(x.amount||0),0),paid=rows.filter(x=>x.status==='Paid').reduce((a,x)=>a+Number(x.amount||0),0);res.json({success:true,payments:rows,summary:{count:rows.length,total,paid,pending:total-paid}});}catch(e){res.status(500).json({success:false,message:'حدث خطأ أثناء إنشاء تقرير الدفعات',error:e.message});}
});

app.use('/uploads', express.static(path.join(__dirname,'uploads'), {maxAge:'1h'}));

app.get('/employee-details',(req,res)=>res.sendFile(__dirname+'/employee-details.html'));
app.get('/payment-details',(req,res)=>res.sendFile(__dirname+'/payment-details.html'));
app.get('/project-details',(req,res)=>res.sendFile(__dirname+'/project-details.html'));
app.get('/invoice-details',(req,res)=>res.sendFile(__dirname+'/invoice-details.html'));

// =====================================================
// EXTRA PAGES
// =====================================================

app.get('/leaves',(req,res)=>res.sendFile(__dirname+'/leaves.html'));
app.get('/end-of-service',(req,res)=>res.sendFile(__dirname+'/end-of-service.html'));
app.get('/users',(req,res)=>res.sendFile(__dirname+'/users.html'));
app.get('/audit-log',(req,res)=>res.sendFile(__dirname+'/audit-log.html'));
app.get('/settings',(req,res)=>res.sendFile(__dirname+'/settings.html'));

// =====================================================
// OTHER MODULE PAGES
// =====================================================

function createModulePage(moduleKey) {

    const module =
        modules[moduleKey];

    return `<!DOCTYPE html>

<html lang="ar" dir="rtl">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>IBuild System</title>

<style>

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: Arial, sans-serif;
    background: #f1f5f9;
    color: #0f172a;
}

.sidebar {
    position: fixed;
    top: 0;
    right: 0;
    width: 260px;
    height: 100vh;
    background: #0f172a;
    color: white;
    padding: 25px 18px;
    z-index: 1000;
}

.logo {
    text-align: center;
    padding: 10px 0 30px;
    border-bottom: 1px solid #334155;
}

.logo h1 {
    font-size: 25px;
}

.logo span {
    color: #3b82f6;
}

.logo p {
    color: #94a3b8;
    font-size: 12px;
    margin-top: 7px;
}

.menu {
    margin-top: 25px;
}

.menu a {
    display: block;
    text-decoration: none;
    color: #cbd5e1;
    padding: 13px 15px;
    margin-bottom: 5px;
    border-radius: 8px;
    font-size: 14px;
    transition: 0.2s;
}

.menu a:hover {
    background: #2563eb;
    color: white;
}

.main {
    margin-right: 260px;
    min-height: 100vh;
}

.topbar {
    min-height: 75px;
    background: white;
    border-bottom: 1px solid #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 15px 35px;
}

.content {
    padding: 35px;
}

.page-card {
    background: white;
    border: 1px solid #e2e8f0;
    border-radius: 15px;
    padding: 40px;
    text-align: center;
}

.icon {
    font-size: 55px;
    margin-bottom: 20px;
}

.page-card h1 {
    margin-bottom: 12px;
}

.page-card p {
    color: #64748b;
    margin-bottom: 25px;
}

.back {
    display: inline-block;
    background: #2563eb;
    color: white;
    text-decoration: none;
    padding: 12px 25px;
    border-radius: 8px;
}

.language {
    display: flex;
    gap: 8px;
}

.language button {
    border: 1px solid #dbeafe;
    background: white;
    padding: 8px 12px;
    border-radius: 7px;
    cursor: pointer;
}

.logout-link { position:absolute; bottom:18px; left:18px; right:18px; border:1px solid #475569; background:#172033; color:white; border-radius:9px; padding:10px 12px; cursor:pointer; }
.sidebar { display:flex; flex-direction:column; }
.menu { overflow:auto; max-height:calc(100vh - 140px); padding-bottom:70px; }

@media(max-width:700px) {

    .sidebar {
        width: 75px;
        padding: 15px 8px;
    }

    .logo h1,
    .logo p {
        display: none;
    }

    .menu a span {
        display: none;
    }

    .main {
        margin-right: 75px;
    }

}

html[dir="ltr"] .sidebar {
    right: auto;
    left: 0;
}

html[dir="ltr"] .main {
    margin-right: 0;
    margin-left: 260px;
}

</style>

</head>

<body>

<aside class="sidebar">

    <div class="logo">

        <h1>
            IBuild <span>System</span>
        </h1>

        <p id="companySystem">
            نظام إدارة الشركة
        </p>

    </div>

    <div class="menu">

        <a href="/dashboard">
            🏠
            <span id="dashboardText">
                لوحة التحكم
            </span>
        </a>

        <a href="/employees">
            👥
            <span id="employeesText">
                الموظفين
            </span>
        </a>

        <a href="/attendance">
            🕐
            <span id="attendanceText">
                الحضور والانصراف
            </span>
        </a>

        <a href="/payroll">
            💰
            <span id="payrollText">
                الرواتب
            </span>
        </a>

        <a href="/invoices">
            📄
            <span id="invoicesText">
                الفواتير
            </span>
        </a>

        <a href="/payments">
            💳
            <span id="paymentsText">
                المدفوعات
            </span>
        </a>

        <a href="/projects">
            🏗️
            <span id="projectsText">
                المشاريع
            </span>
        </a>

        <a href="/reports">
            📊
            <span id="reportsText">
                التقارير
            </span>
        </a>

        <a href="/settings">
            ⚙️
            <span id="settingsText">
                الإعدادات
            </span>
        </a>

    </div>

    <button type="button" class="logout-link" onclick="logoutFromSystem()">🚪 تسجيل الخروج</button>

</aside>

<main class="main">

<header class="topbar">

    <h2 id="pageTitle">
        ${module.ar}
    </h2>

    <div class="language">

        <button onclick="setLanguage('ar')">
            العربية
        </button>

        <button onclick="setLanguage('en')">
            English
        </button>

    </div>

</header>

<section class="content">

    <div class="page-card">

        <div class="icon">
            ${module.icon}
        </div>

        <h1 id="moduleTitle">
            ${module.ar}
        </h1>

        <p id="moduleDescription">
            هذا القسم من نظام IBuild سيتم تجهيزه وربطه بقاعدة البيانات.
        </p>

        <a
            href="/dashboard"
            class="back"
            id="backButton">

            العودة إلى لوحة التحكم

        </a>

    </div>

</section>

</main>

<script>

const moduleData = {

    ar: {

        title:
            "${module.ar}",

        description:
            "هذا القسم من نظام IBuild سيتم تجهيزه وربطه بقاعدة البيانات.",

        back:
            "العودة إلى لوحة التحكم"

    },

    en: {

        title:
            "${module.en}",

        description:
            "This IBuild System module will be developed and connected to the database.",

        back:
            "Back to Dashboard"

    }

};

const menuData = {

    ar: {

        companySystem:
            "نظام إدارة الشركة",

        dashboard:
            "لوحة التحكم",

        employees:
            "الموظفين",

        attendance:
            "الحضور والانصراف",

        payroll:
            "الرواتب",

        invoices:
            "الفواتير",

        payments:
            "المدفوعات",

        projects:
            "المشاريع",

        reports:
            "التقارير",

        settings:
            "الإعدادات"

    },

    en: {

        companySystem:
            "Company Management System",

        dashboard:
            "Dashboard",

        employees:
            "Employees",

        attendance:
            "Attendance",

        payroll:
            "Payroll",

        invoices:
            "Invoices",

        payments:
            "Payments",

        projects:
            "Projects",

        reports:
            "Reports",

        settings:
            "Settings"

    }

};

function setLanguage(language) {

    localStorage.setItem(
        "ibuild_language",
        language
    );

    document.documentElement.lang =
        language;

    document.documentElement.dir =
        language === "ar"
            ? "rtl"
            : "ltr";

    document.getElementById(
        "pageTitle"
    ).textContent =
        moduleData[language].title;

    document.getElementById(
        "moduleTitle"
    ).textContent =
        moduleData[language].title;

    document.getElementById(
        "moduleDescription"
    ).textContent =
        moduleData[language].description;

    document.getElementById(
        "backButton"
    ).textContent =
        moduleData[language].back;

    document.getElementById(
        "companySystem"
    ).textContent =
        menuData[language].companySystem;

    document.getElementById(
        "dashboardText"
    ).textContent =
        menuData[language].dashboard;

    document.getElementById(
        "employeesText"
    ).textContent =
        menuData[language].employees;

    document.getElementById(
        "attendanceText"
    ).textContent =
        menuData[language].attendance;

    document.getElementById(
        "payrollText"
    ).textContent =
        menuData[language].payroll;

    document.getElementById(
        "invoicesText"
    ).textContent =
        menuData[language].invoices;

    document.getElementById(
        "paymentsText"
    ).textContent =
        menuData[language].payments;

    document.getElementById(
        "projectsText"
    ).textContent =
        menuData[language].projects;

    document.getElementById(
        "reportsText"
    ).textContent =
        menuData[language].reports;

    const settingsText =
        document.getElementById("settingsText");

    if (settingsText) {
        settingsText.textContent =
            menuData[language].settings;
    }

}

async function logoutFromSystem(){
    try { await fetch('/api/auth/logout',{method:'POST'}); } finally { location.href='/login'; }
}

const savedLanguage =
    localStorage.getItem(
        "ibuild_language"
    ) || "ar";

setLanguage(savedLanguage);

</script>

</body>

</html>`;

}

// =====================================================
// REPORTS PAGE
// =====================================================

app.get("/reports", (req, res) => {
    res.sendFile(__dirname + "/reports.html");
});

// =====================================================
// MODULE ROUTES
// =====================================================

Object.keys(modules).forEach(
    function (moduleKey) {

        if (
            moduleKey === "employees" ||
            moduleKey === "payroll" ||
            moduleKey === "attendance" ||
            moduleKey === "payments" ||
            moduleKey === "projects"
        ) {

            return;

        }

        app.get(
            "/" + moduleKey,
            (req, res) => {

                res.send(
                    createModulePage(
                        moduleKey
                    )
                );

            }
        );

    }
);

// =====================================================
// 404
// =====================================================

app.use(
    (req, res) => {

        res.status(404).send(`

            <div style="
                font-family:Arial;
                text-align:center;
                padding:100px;
            ">

                <h1>404</h1>

                <p>
                    الصفحة غير موجودة
                </p>

                <br>

                <a href="/dashboard">
                    العودة إلى لوحة التحكم
                </a>

            </div>

        `);

    }
);

// =====================================================
// DATABASE COMPATIBILITY / SAFE MIGRATIONS
// =====================================================

async function ensureDatabaseCompatibility() {
    // The current database dump uses `attendance`, while the application
    // API uses the clearer `attendance_records` name. Keep both compatible
    // without destroying existing attendance data.
    const [attendanceColumns] = await db.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'attendance'
          AND COLUMN_NAME = 'status'
        LIMIT 1
    `);

    if (attendanceColumns.length) {
        await db.query(`
            ALTER TABLE attendance
            MODIFY COLUMN status
            ENUM('Present','Absent','Late','Half Day','Leave','Off','Sick')
            DEFAULT 'Present'
        `);
    }

    const [salaryColumns] = await db.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'employees'
          AND COLUMN_NAME = 'payroll_salary'
        LIMIT 1
    `);

    if (!salaryColumns.length) {
        await db.query(`
            ALTER TABLE employees
            ADD COLUMN payroll_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00
            AFTER basic_salary
        `);

        // Existing employees should have a usable payroll salary immediately.
        await db.query(`
            UPDATE employees
            SET payroll_salary = COALESCE(basic_salary, 0)
            WHERE payroll_salary = 0
        `);
    }

    const [viewRows] = await db.query(`
        SELECT TABLE_NAME, TABLE_TYPE
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'attendance_records'
        LIMIT 1
    `);

    if (!viewRows.length) {
        await db.query(`
            CREATE VIEW attendance_records AS
            SELECT
                id,
                employee_id,
                attendance_date,
                check_in,
                check_out,
                status,
                overtime_hours,
                notes,
                created_at
            FROM attendance
        `);
    } else if (viewRows[0].TABLE_TYPE === 'VIEW') {
        await db.query(`
            CREATE OR REPLACE VIEW attendance_records AS
            SELECT
                id,
                employee_id,
                attendance_date,
                check_in,
                check_out,
                status,
                overtime_hours,
                notes,
                created_at
            FROM attendance
        `);
    }

    // Payroll overtime hours are additive and safe for existing databases.
    const [payrollOvertimeCols] = await db.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'payroll_records'
          AND COLUMN_NAME = 'overtime_hours'
        LIMIT 1
    `);
    if (!payrollOvertimeCols.length) {
        await db.query(`
            ALTER TABLE payroll_records
            ADD COLUMN overtime_hours DECIMAL(10,2) NOT NULL DEFAULT 0
            AFTER overtime_amount
        `);
    }

    // Safe application tables. They are additive and never delete existing data.
    await db.query(`CREATE TABLE IF NOT EXISTS users (
        id INT NOT NULL AUTO_INCREMENT,
        full_name VARCHAR(150) NOT NULL,
        username VARCHAR(80) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('Admin','Manager','Accountant','HR','Viewer') NOT NULL DEFAULT 'Viewer',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await db.query(`CREATE TABLE IF NOT EXISTS leave_requests (
        id INT NOT NULL AUTO_INCREMENT,
        employee_id INT NOT NULL,
        leave_type VARCHAR(80) NOT NULL DEFAULT 'Annual',
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days DECIMAL(8,2) NOT NULL DEFAULT 0,
        status ENUM('Pending','Approved','Rejected','Cancelled') NOT NULL DEFAULT 'Pending',
        reason TEXT,
        approved_by INT NULL,
        approved_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id), KEY idx_leave_employee(employee_id), KEY idx_leave_dates(start_date,end_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await db.query(`CREATE TABLE IF NOT EXISTS employee_documents (
        id INT NOT NULL AUTO_INCREMENT,
        employee_id INT NOT NULL,
        document_type VARCHAR(100) NOT NULL,
        document_number VARCHAR(150) NULL,
        issue_date DATE NULL,
        expiry_date DATE NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id), KEY idx_doc_employee(employee_id), KEY idx_doc_expiry(expiry_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await db.query(`CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT NOT NULL AUTO_INCREMENT,
        user_id INT NULL,
        username VARCHAR(80) NULL,
        action VARCHAR(50) NOT NULL,
        entity VARCHAR(80) NOT NULL,
        entity_id INT NULL,
        details JSON NULL,
        ip_address VARCHAR(80) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id), KEY idx_audit_created(created_at), KEY idx_audit_entity(entity,entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Add a configurable progress percentage to projects if missing.
    const [progressCols] = await db.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND COLUMN_NAME='progress_percentage' LIMIT 1`);
    if (!progressCols.length) {
        await db.query(`ALTER TABLE projects ADD COLUMN progress_percentage DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER status`);
    }

    // Employee master-data fields (additive; existing data is preserved).
    const employeeFields = [
        ['birth_date','DATE NULL'],['gender',"ENUM('Male','Female') NULL"],['marital_status',"ENUM('Single','Married') NULL"],
        ['id_number','VARCHAR(80) NULL'],['id_issue_date','DATE NULL'],['id_expiry_date','DATE NULL'],['phone_country_code','VARCHAR(10) NULL']
    ];
    for (const [field,type] of employeeFields) {
        const [c]=await db.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME=? LIMIT 1`,[field]);
        if(!c.length) await db.query(`ALTER TABLE employees ADD COLUMN ${field} ${type}`);
    }
    // Leave attachments for flight tickets, receipts and supporting documents.
    await db.query(`CREATE TABLE IF NOT EXISTS leave_documents (
        id INT NOT NULL AUTO_INCREMENT, leave_id INT NOT NULL, document_type VARCHAR(80) NOT NULL DEFAULT 'Attachment',
        original_name VARCHAR(255) NULL, stored_name VARCHAR(255) NULL, file_path VARCHAR(500) NULL,
        mime_type VARCHAR(150) NULL, file_size BIGINT NULL, notes TEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(id), KEY idx_leave_doc_leave(leave_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Add a basic leave entitlement column if missing.
    const [leaveCols] = await db.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='annual_leave_days' LIMIT 1`);
    if (!leaveCols.length) {
        await db.query(`ALTER TABLE employees ADD COLUMN annual_leave_days DECIMAL(6,2) NOT NULL DEFAULT 30 AFTER other_allowance`);
    }

    // Project costs are additive and safe for existing databases.
    await db.query(`CREATE TABLE IF NOT EXISTS project_expenses (
        id INT NOT NULL AUTO_INCREMENT,
        project_id INT NOT NULL,
        expense_date DATE NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'General',
        description VARCHAR(255) NULL,
        amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        reference_number VARCHAR(120) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(id), KEY idx_project_expenses_project(project_id), KEY idx_project_expenses_date(expense_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Seed / synchronize the three company administrative accounts. Passwords are stored as bcrypt hashes.
    const bcrypt = require('bcryptjs');
    const companyAdmins = [
        {full_name:'Mahmoud', username:'Mahmoud', password:'12345677', role:'Admin'},
        {full_name:'Amir', username:'Amir', password:'123455', role:'Manager'},
        {full_name:'Ajmal', username:'Ajmal', password:'1234566', role:'Accountant'}
    ];
    for (const account of companyAdmins) {
        const [existing] = await db.query(`SELECT id FROM users WHERE username=? LIMIT 1`, [account.username]);
        const hash = await bcrypt.hash(account.password, 12);
        if (existing.length) {
            await db.query(`UPDATE users SET full_name=?, password_hash=?, role=?, is_active=1 WHERE id=?`, [account.full_name, hash, account.role, existing[0].id]);
        } else {
            await db.query(`INSERT INTO users(full_name,username,password_hash,role,is_active) VALUES(?,?,?,?,1)`, [account.full_name, account.username, hash, account.role]);
        }
    }
    // Keep Mahmoud as the only Super Admin. Existing legacy Admin accounts are safely reduced to Manager.
    await db.query(`UPDATE users SET role='Manager' WHERE role='Admin' AND username <> 'Mahmoud'`);

    // Seed one administrator only when no users exist. Change it immediately in Users.
    const [userCount] = await db.query(`SELECT COUNT(*) AS total FROM users`);
    if (Number(userCount[0]?.total || 0) === 0) {
        const bcrypt = require('bcryptjs');
        const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'Admin@12345';
        const hash = await bcrypt.hash(initialPassword, 12);
        await db.query(`INSERT INTO users (full_name,username,password_hash,role,is_active) VALUES (?,?,?,?,1)`, [process.env.ADMIN_INITIAL_NAME || 'System Administrator', process.env.ADMIN_INITIAL_USERNAME || 'admin', hash, 'Admin']);
        console.log('Initial admin created. Username:', process.env.ADMIN_INITIAL_USERNAME || 'admin');
        console.log('Initial admin password is controlled by ADMIN_INITIAL_PASSWORD or defaults to Admin@12345. Change it after first login.');
    }
}

// =====================================================
// SERVER
// =====================================================

async function startServer() {
    try {
        await db.query("SELECT 1");
        await ensureDatabaseCompatibility();
        await ensureDetailSchema();

        app.listen(
            PORT,
            () => {
                console.log("=================================");
                console.log("IBuild System Backend");
                console.log("Server running on port:", PORT);
                console.log(`http://localhost:${PORT}`);
                console.log("=================================");
            }
        );
    } catch (error) {
        console.error("SERVER START ERROR:", error.message);
        process.exit(1);
    }
}

startServer();