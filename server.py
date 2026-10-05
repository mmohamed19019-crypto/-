import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import traceback
import getpass
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DAWAEY_DB_PATH", ROOT / "data" / "dawaey.sqlite3"))
SESSION_COOKIE = "dawaey_session"
ADMIN_SESSION_COOKIE = "dawaey_admin_session"
SESSION_HOURS = 12
MAX_BODY = 2 * 1024 * 1024
GOVERNORATES = (
    "القاهرة", "الجيزة", "الإسكندرية", "القليوبية", "الشرقية", "الدقهلية",
    "البحيرة", "الغربية", "المنوفية", "كفر الشيخ", "دمياط", "بورسعيد",
    "الإسماعيلية", "السويس", "شمال سيناء", "جنوب سيناء", "الفيوم",
    "بني سويف", "المنيا", "أسيوط", "سوهاج", "قنا", "الأقصر", "أسوان",
    "البحر الأحمر", "الوادي الجديد", "مطروح",
)
ARABIC_ALIASES = {
    "Panadol": "بانادول", "Panadol Extra": "بانادول اكسترا", "Adol": "ادول",
    "Paracetamol": "باراسيتامول", "Fevadol": "فيفادول", "Augmentin": "أوجمنتين",
    "Amoxicillin": "أموكسيسيلين", "Amoxil": "أموكسيل", "Zinnat": "زينات",
    "Cefixime": "سيفيكسيم", "Suprax": "سوبراكس", "Azithromycin": "أزيثروميسين",
    "Zithromax": "زيثروماكس", "Flagyl": "فلاجيل", "Brufen": "بروفين",
    "Profenid": "بروفينيد", "Voltaren": "فولتارين", "Cataflam": "كتافلام",
    "Celebrex": "سيليبريكس", "Arcoxia": "أركوكسيا", "Mobic": "موبيك",
    "Aspirin": "أسبرين", "Disprin": "ديسبرين", "Congestal": "كونجيستال",
    "Telfast": "تلفاست", "Claritine": "كلاريتين", "Claritin": "كلاريتين",
    "Cetirizine": "سيتريزين", "Loratadine": "لوراتادين", "Otrivin": "أوتريفين",
    "Tobradex": "توبراديكس", "Tobrex": "توبركس", "Glucophage": "جلوكوفاج",
    "Metformin": "ميتفورمين", "Lantus": "لانتوس", "Euthyrox": "يوثيروكس",
    "Concor": "كونكور", "Norvasc": "نورفاسك", "Diovan": "ديوفان",
    "Lasix": "لازكس", "Buscopan": "بوسكوبان", "Gaviscon": "جافيسكون",
    "Omeprazole": "أوميبرازول", "Losec": "لوسيك", "Nexium": "نيكسيوم",
    "Motilium": "موتيليوم", "Zofran": "زوفران", "Imodium": "إيموديوم",
    "Ventolin": "فنتولين", "Seretide": "سيريتايد", "Pulmicort": "بولميكورت",
    "Mucosolvan": "ميوكوسولفان", "Fucidin": "فيوسيدين", "Bactroban": "باكتروبان",
    "Betadine": "بيتادين", "Bepanthen": "بيبانثين", "Canesten": "كانستين",
    "Diflucan": "ديفلوكان", "Zovirax": "زوفيراكس", "Feroglobin": "فيروجلوبين",
    "Fefol": "فيفول", "Vitamin D3": "فيتامين د٣", "Omega 3": "أوميجا ٣",
    "Vitamin C": "فيتامين سي", "Folic Acid": "حمض الفوليك", "Zinc": "زنك",
    "Pregabalin": "بريجابالين", "Lyrica": "ليريكا", "Gabapentin": "جابابنتين",
    "Tegretol": "تيجريتول", "Panadol Extra": "بانادول اكسترا",
}
DB_LOCK = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def migrate_role_scoped_user_contacts(db):
    unique_indexes = db.execute("PRAGMA index_list(users)").fetchall()
    legacy_unique_columns = {"contact", "phone", "whatsapp"}
    requires_rebuild = any(
        index["unique"]
        and len(columns := [
            row["name"] for row in db.execute(f'PRAGMA index_info("{index["name"]}")')
        ]) == 1
        and columns[0] in legacy_unique_columns
        for index in unique_indexes
    )
    if requires_rebuild:
        db.execute("PRAGMA foreign_keys = OFF")
        db.executescript(
            """
            DROP TRIGGER IF EXISTS users_unique_contact_points_insert;
            DROP TRIGGER IF EXISTS users_unique_contact_points_update;
            CREATE TABLE users_role_scoped (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL CHECK (role IN ('patient','pharmacy','admin')),
                contact TEXT NOT NULL,
                phone TEXT,
                whatsapp TEXT,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                profile TEXT NOT NULL,
                rejection_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO users_role_scoped
            SELECT id,role,contact,phone,whatsapp,password_salt,password_hash,status,
                   profile,rejection_reason,created_at,updated_at
            FROM users;
            DROP TABLE users;
            ALTER TABLE users_role_scoped RENAME TO users;
            """
        )
        db.commit()
        db.execute("PRAGMA foreign_keys = ON")
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise sqlite3.IntegrityError("User contact migration found broken references.")

    db.executescript(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role_contact ON users(role, contact);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role_phone ON users(role, phone);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role_whatsapp ON users(role, whatsapp);
        CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
        DROP TRIGGER IF EXISTS users_unique_contact_points_insert;
        DROP TRIGGER IF EXISTS users_unique_contact_points_update;
        CREATE TRIGGER users_unique_contact_points_insert
        BEFORE INSERT ON users
        WHEN EXISTS (
            SELECT 1 FROM users existing
            WHERE existing.role = NEW.role
              AND (
                NEW.contact IN (existing.contact, existing.phone, existing.whatsapp)
                OR (NEW.phone IS NOT NULL AND NEW.phone IN (existing.contact, existing.phone, existing.whatsapp))
                OR (NEW.whatsapp IS NOT NULL AND NEW.whatsapp IN (existing.contact, existing.phone, existing.whatsapp))
              )
        )
        BEGIN
            SELECT RAISE(ABORT, 'duplicate_contact_point');
        END;
        CREATE TRIGGER users_unique_contact_points_update
        BEFORE UPDATE OF contact, phone, whatsapp ON users
        WHEN EXISTS (
            SELECT 1 FROM users existing
            WHERE existing.id != NEW.id
              AND existing.role = NEW.role
              AND (
                NEW.contact IN (existing.contact, existing.phone, existing.whatsapp)
                OR (NEW.phone IS NOT NULL AND NEW.phone IN (existing.contact, existing.phone, existing.whatsapp))
                OR (NEW.whatsapp IS NOT NULL AND NEW.whatsapp IN (existing.contact, existing.phone, existing.whatsapp))
              )
        )
        BEGIN
            SELECT RAISE(ABORT, 'duplicate_contact_point');
        END;
        """
    )


@contextmanager
def db_connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def normalize_contact(value):
    text = str(value or "").translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")).strip().lower()
    if "@" in text:
        return text
    digits = re.sub(r"\D", "", text)
    if digits.startswith("20") and len(digits) == 12:
        return "0" + digits[2:]
    if len(digits) == 10 and digits.startswith(("10", "11", "12", "15")):
        return "0" + digits
    return digits


def password_hash(password, salt=None):
    salt_bytes = bytes.fromhex(salt) if salt else secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt_bytes, n=2**14, r=8, p=1, dklen=32)
    return salt_bytes.hex(), derived.hex()


def verify_password(password, salt, expected):
    try:
        _, actual = password_hash(password, salt)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def load_seed_data():
    source = (ROOT / "data.js").read_text(encoding="utf-8")
    marker = "window.DAWAEY_DATA = "
    if not source.startswith(marker):
        raise RuntimeError("data.js must start with window.DAWAEY_DATA JSON.")
    return json.loads(source[len(marker):].strip().rstrip(";"))


def transliterate_brand(name):
    text = name.lower()
    for source, replacement in (
        ("tion", "شن"), ("tch", "تش"), ("sch", "ش"), ("sh", "ش"),
        ("ch", "تش"), ("kh", "خ"), ("gh", "غ"), ("ph", "ف"),
        ("th", "ث"), ("oo", "و"), ("ee", "ي"), ("ea", "يا"),
        ("ai", "اي"), ("ei", "اي"), ("ou", "او"), ("qu", "ك"),
    ):
        text = text.replace(source, replacement)
    letters = {
        "a": "ا", "b": "ب", "c": "ك", "d": "د", "e": "ي", "f": "ف",
        "g": "ج", "h": "ه", "i": "ي", "j": "ج", "k": "ك", "l": "ل",
        "m": "م", "n": "ن", "o": "و", "p": "ب", "q": "ق", "r": "ر",
        "s": "س", "t": "ت", "u": "و", "v": "ف", "w": "و", "x": "كس",
        "y": "ي", "z": "ز",
    }
    return "".join(letters.get(char, " " if char.isspace() else char) for char in text).strip()


def initialize_database():
    seed = load_seed_data()
    with DB_LOCK, db_connect() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL CHECK (role IN ('patient','pharmacy','admin')),
                contact TEXT NOT NULL,
                phone TEXT,
                whatsapp TEXT,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                profile TEXT NOT NULL,
                rejection_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS login_attempts (
                contact TEXT PRIMARY KEY,
                window_started REAL NOT NULL,
                attempts INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS medicines (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                arabic_names TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                unit TEXT NOT NULL DEFAULT '',
                quantity INTEGER NOT NULL DEFAULT 0,
                stock_status TEXT NOT NULL DEFAULT '',
                minimum INTEGER NOT NULL DEFAULT 0,
                suggested_supply INTEGER NOT NULL DEFAULT 0,
                code TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS pharmacies (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                address TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                governorate TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'seed'
            );
            CREATE TABLE IF NOT EXISTS shortage_reports (
                id TEXT PRIMARY KEY,
                medicine_id INTEGER NOT NULL REFERENCES medicines(id),
                governorate TEXT NOT NULL,
                severity TEXT NOT NULL CHECK (severity IN ('shortage','unavailable')),
                source TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                reporter_id TEXT NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_id TEXT NOT NULL,
                actor_contact TEXT NOT NULL,
                action TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                details TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
            CREATE INDEX IF NOT EXISTS idx_shortage_area ON shortage_reports(governorate, medicine_id);
            CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);
            """
        )
        migrate_role_scoped_user_contacts(db)
        if db.execute("SELECT COUNT(*) FROM medicines").fetchone()[0] == 0:
            db.executemany(
                """INSERT INTO medicines
                (id,name,arabic_names,category,unit,quantity,stock_status,minimum,suggested_supply,code)
                VALUES (:id,:name,:arabic_names,:category,:unit,:quantity,:stockStatus,:minimum,:suggestedSupply,:code)""",
                [
                    {**medicine, "arabic_names": ARABIC_ALIASES.get(medicine["name"], transliterate_brand(medicine["name"]))}
                    for medicine in seed["medicines"]
                ],
            )
        if db.execute("SELECT COUNT(*) FROM pharmacies WHERE source='seed'").fetchone()[0] == 0:
            db.executemany(
                """INSERT INTO pharmacies (id,name,address,phone,governorate,source)
                VALUES (:id,:name,:address,:phone,:governorate,'seed')""",
                [
                    {
                        **pharmacy,
                        "governorate": next((area for area in GOVERNORATES if area in pharmacy["address"]), ""),
                    }
                    for pharmacy in seed["pharmacies"]
                ],
            )

        raw_admin_email = os.environ.get("DAWAEY_ADMIN_EMAIL", "")
        admin_email = normalize_contact(raw_admin_email)
        admin_password = os.environ.get("DAWAEY_ADMIN_PASSWORD", "")
        existing_admin = db.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone()
        if (raw_admin_email or admin_password) and not existing_admin:
            if not raw_admin_email or not admin_password:
                raise RuntimeError("Set both DAWAEY_ADMIN_EMAIL and DAWAEY_ADMIN_PASSWORD.")
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", admin_email):
                raise RuntimeError("DAWAEY_ADMIN_EMAIL must be a valid email address.")
            if len(admin_password) < 12 or not re.search(r"[a-z]", admin_password) or not re.search(r"[A-Z]", admin_password) or not re.search(r"\d", admin_password):
                raise RuntimeError("DAWAEY_ADMIN_PASSWORD must be 12+ characters with uppercase, lowercase, and a number.")
            salt, hashed = password_hash(admin_password)
            admin_id = "admin_" + secrets.token_hex(12)
            db.execute(
                """INSERT INTO users
                (id,role,contact,password_salt,password_hash,status,profile,created_at,updated_at)
                VALUES (?,'admin',?,?,?,'active',?,?,?)""",
                (
                    admin_id, admin_email, salt, hashed,
                    json.dumps({"name": "إدارة دوائي"}, ensure_ascii=False),
                    now_iso(), now_iso(),
                ),
            )


def safe_user(row):
    profile = json.loads(row["profile"])
    return {
        "id": row["id"], "role": row["role"], "contact": row["contact"],
        "phone": row["phone"], "whatsapp": row["whatsapp"], "status": row["status"],
        "rejectionReason": row["rejection_reason"], "createdAt": row["created_at"],
        **profile,
    }


def log_action(db, actor, action, target_type, target_id, details):
    db.execute(
        """INSERT INTO audit_log (actor_id,actor_contact,action,target_type,target_id,details,created_at)
        VALUES (?,?,?,?,?,?,?)""",
        (
            actor["id"], actor["contact"], action, target_type, str(target_id),
            json.dumps(details, ensure_ascii=False, separators=(",", ":")), now_iso(),
        ),
    )


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class DawaeyHandler(SimpleHTTPRequestHandler):
    server_version = "Dawaey/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self)")
        super().end_headers()

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == "/api/auth/session":
                user = self.require_user()
                return self.json_response(HTTPStatus.OK, {"user": user})
            if path == "/api/admin/session":
                user = self.require_admin()
                return self.json_response(HTTPStatus.OK, {"user": user})
            if path == "/api/shortages":
                return self.public_shortages()
            if path.startswith("/api/admin/"):
                self.require_admin()
                if path == "/api/admin/overview":
                    return self.admin_overview()
                raise ApiError(HTTPStatus.NOT_FOUND, "المسار غير موجود.")
            if path == "/data.js":
                return self.dynamic_catalog()
            return super().do_GET()
        except ApiError as error:
            self.json_response(error.status, {"error": error.message})
        except Exception:
            print("Unhandled GET error")
            traceback.print_exc()
            self.json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "حصل خطأ داخلي."})

    def do_POST(self):
        try:
            self.check_origin()
            body = self.read_json()
            path = urlsplit(self.path).path
            if path == "/api/auth/register":
                return self.register(body)
            if path == "/api/auth/login":
                return self.login(body)
            if path == "/api/auth/logout":
                actor = self.request_user()
                self.revoke_session(SESSION_COOKIE)
                if actor:
                    with db_connect() as db:
                        log_action(db, actor, "user_logout", "user", actor["id"], {})
                self.send_response(HTTPStatus.OK)
                self.send_header_cookie("", clear=True, cookie_name=SESSION_COOKIE)
                payload = b'{"ok":true}'
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if path == "/api/admin/logout":
                actor = self.require_admin()
                self.revoke_session(ADMIN_SESSION_COOKIE)
                with db_connect() as db:
                    log_action(db, actor, "admin_logout", "user", actor["id"], {})
                self.send_response(HTTPStatus.OK)
                self.send_header_cookie("", clear=True, cookie_name=ADMIN_SESSION_COOKIE)
                payload = b'{"ok":true}'
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if path == "/api/admin/reports":
                actor = self.require_admin()
                return self.create_report(body, actor)
            if path == "/api/admin/login":
                return self.admin_login(body)
            raise ApiError(HTTPStatus.NOT_FOUND, "المسار غير موجود.")
        except ApiError as error:
            self.json_response(error.status, {"error": error.message})
        except Exception:
            print("Unhandled POST error")
            traceback.print_exc()
            self.json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "حصل خطأ داخلي."})

    def do_PUT(self):
        try:
            self.check_origin()
            path = urlsplit(self.path).path
            if path != "/api/profile":
                raise ApiError(HTTPStatus.NOT_FOUND, "المسار غير موجود.")
            return self.update_profile()
        except ApiError as error:
            self.json_response(error.status, {"error": error.message})
        except Exception:
            print("Unhandled PUT error")
            traceback.print_exc()
            self.json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "حصل خطأ داخلي."})

    def do_PATCH(self):
        try:
            self.check_origin()
            body = self.read_json()
            path = urlsplit(self.path).path
            actor = self.require_admin()
            pharmacy = re.fullmatch(r"/api/admin/pharmacies/([^/]+)", path)
            if pharmacy:
                return self.review_pharmacy(unquote(pharmacy.group(1)), body, actor)
            user = re.fullmatch(r"/api/admin/users/([^/]+)", path)
            if user:
                return self.update_user(unquote(user.group(1)), body, actor)
            medicine = re.fullmatch(r"/api/admin/medicines/(\d+)", path)
            if medicine:
                return self.update_medicine(int(medicine.group(1)), body, actor)
            raise ApiError(HTTPStatus.NOT_FOUND, "المسار غير موجود.")
        except ApiError as error:
            self.json_response(error.status, {"error": error.message})
        except Exception:
            print("Unhandled PATCH error")
            traceback.print_exc()
            self.json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "حصل خطأ داخلي."})

    def do_DELETE(self):
        try:
            self.check_origin()
            self.read_json(allow_empty=True)
            path = urlsplit(self.path).path
            actor = self.require_admin()
            report = re.fullmatch(r"/api/admin/reports/([^/]+)", path)
            if report:
                report_id = unquote(report.group(1))
                with db_connect() as db:
                    item = db.execute("SELECT * FROM shortage_reports WHERE id=?", (report_id,)).fetchone()
                    if not item:
                        raise ApiError(HTTPStatus.NOT_FOUND, "البلاغ غير موجود.")
                    db.execute("DELETE FROM shortage_reports WHERE id=?", (report_id,))
                    log_action(db, actor, "shortage_report_deleted", "shortage_report", report_id, {
                        "medicineId": item["medicine_id"], "governorate": item["governorate"],
                    })
                return self.json_response(HTTPStatus.OK, {"ok": True})
            raise ApiError(HTTPStatus.NOT_FOUND, "المسار غير موجود.")
        except ApiError as error:
            self.json_response(error.status, {"error": error.message})
        except Exception:
            print("Unhandled DELETE error")
            traceback.print_exc()
            self.json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "حصل خطأ داخلي."})

    def check_origin(self):
        origin = self.headers.get("Origin")
        if origin:
            expected = f"{self.headers.get('X-Forwarded-Proto', 'http')}://{self.headers.get('Host', '')}"
            if origin.rstrip("/") != expected.rstrip("/"):
                raise ApiError(HTTPStatus.FORBIDDEN, "مصدر الطلب غير مسموح.")
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("application/json"):
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "يجب إرسال JSON.")

    def read_json(self, allow_empty=False):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "حجم الطلب غير صالح.")
        if length > MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "حجم البيانات أكبر من المسموح.")
        if length == 0 and allow_empty:
            return {}
        if length <= 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "بيانات الطلب مطلوبة.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "صيغة JSON غير صالحة.")
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "صيغة البيانات غير صالحة.")
        return payload

    def json_response(self, status, payload):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def send_header_cookie(self, token, clear=False, cookie_name=SESSION_COOKIE):
        secure = "; Secure" if os.environ.get("DAWAEY_COOKIE_SECURE") == "1" else ""
        max_age = "; Max-Age=0" if clear else f"; Max-Age={SESSION_HOURS * 3600}"
        self.send_header(
            "Set-Cookie",
            f"{cookie_name}={token}; Path=/; HttpOnly; SameSite=Strict{secure}{max_age}",
        )

    def set_session(self, user_id, admin=False):
        raw = secrets.token_urlsafe(32)
        hashed = hashlib.sha256(raw.encode()).hexdigest()
        expires = (datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)).isoformat()
        with db_connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at < ?", (now_iso(),))
            db.execute("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)", (hashed, user_id, expires))
        return raw

    def request_user(self, cookie_name=SESSION_COOKIE):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get(cookie_name)
        if not morsel:
            return None
        hashed = hashlib.sha256(morsel.value.encode()).hexdigest()
        with db_connect() as db:
            row = db.execute(
                """SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
                WHERE sessions.token_hash=? AND sessions.expires_at>?""",
                (hashed, now_iso()),
            ).fetchone()
        return safe_user(row) if row else None

    def require_user(self):
        user = self.request_user()
        if not user:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "سجّلي الدخول أولًا.")
        return user

    def require_admin(self):
        user = self.request_user(ADMIN_SESSION_COOKIE)
        if not user:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "سجّلي الدخول بحساب الإدارة.")
        if user["role"] != "admin":
            raise ApiError(HTTPStatus.FORBIDDEN, "هذه الصفحة متاحة للإدارة فقط.")
        return user

    def revoke_session(self, cookie_name=SESSION_COOKIE):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return
        morsel = cookie.get(cookie_name)
        if morsel:
            token_hash = hashlib.sha256(morsel.value.encode()).hexdigest()
            with db_connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))

    def login(self, body):
        contact = normalize_contact(body.get("contact"))
        password = body.get("password", "")
        expected_role = body.get("expectedRole")
        if expected_role not in (None, "patient", "pharmacy"):
            raise ApiError(HTTPStatus.BAD_REQUEST, "نوع الحساب المطلوب غير صالح.")
        if not contact or not isinstance(password, str) or len(password) > 256:
            raise ApiError(HTTPStatus.BAD_REQUEST, "أدخلي وسيلة التواصل وكلمة المرور.")
        self.check_login_limit(contact)
        with db_connect() as db:
            rows = db.execute(
                "SELECT * FROM users WHERE contact=? AND role IN ('patient','pharmacy') ORDER BY role",
                (contact,),
            ).fetchall()
            row = next((candidate for candidate in rows if candidate["role"] == expected_role), None) if expected_role else None
            if not expected_role:
                if len(rows) > 1:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "لديك حسابان بهذا الرقم. اختاري دخول المريض أو دخول الصيدلية.")
                row = rows[0] if rows else None
            if not row and not rows:
                admin_exists = db.execute(
                    "SELECT 1 FROM users WHERE contact=? AND role='admin'", (contact,)
                ).fetchone()
                if admin_exists:
                    raise ApiError(HTTPStatus.FORBIDDEN, "استخدمي صفحة إدارة دوائي لتسجيل دخول الإدارة.")
        if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
            other_role_user = next((candidate for candidate in rows if candidate["role"] != expected_role), None) if expected_role else None
            if other_role_user and verify_password(password, other_role_user["password_salt"], other_role_user["password_hash"]):
                if expected_role == "pharmacy":
                    raise ApiError(HTTPStatus.FORBIDDEN, "هذا حساب مريض. اختاري دخول حساب المريض.")
                raise ApiError(HTTPStatus.FORBIDDEN, "هذا حساب صيدلية. اختاري دخول حساب الصيدلية.")
            self.record_login_failure(contact)
            raise ApiError(HTTPStatus.UNAUTHORIZED, "بيانات الدخول غير صحيحة.")
        if row["status"] == "suspended":
            raise ApiError(HTTPStatus.FORBIDDEN, "الحساب موقوف. تواصلي مع الإدارة.")
        if expected_role and row["role"] != expected_role:
            if expected_role == "pharmacy":
                raise ApiError(HTTPStatus.FORBIDDEN, "الحساب ده مش مسجل كصيدلية. استخدمي دخول حساب المريض أو سجّلي صيدلية جديدة.")
            raise ApiError(HTTPStatus.FORBIDDEN, "الحساب ده مش مسجل كمريض. استخدمي دخول الصيدلية أو أنشئي حساب مريض جديد.")
        self.record_login_success(contact)
        with db_connect() as db:
            log_action(db, {"id": row["id"], "contact": row["contact"]}, "user_login", "user", row["id"], {"role": row["role"]})
        token = self.set_session(row["id"])
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header_cookie(token)
        body_bytes = json.dumps({"user": safe_user(row)}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def admin_login(self, body):
        contact = normalize_contact(body.get("contact"))
        password = body.get("password", "")
        self.check_login_limit(contact)
        with db_connect() as db:
            row = db.execute("SELECT * FROM users WHERE contact=? AND role='admin'", (contact,)).fetchone()
        if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
            self.record_login_failure(contact)
            raise ApiError(HTTPStatus.UNAUTHORIZED, "بيانات الإدارة غير صحيحة. راجعي إعدادات الخادم.")
        self.record_login_success(contact)
        with db_connect() as db:
            log_action(db, {"id": row["id"], "contact": row["contact"]}, "admin_login", "user", row["id"], {})
        token = self.set_session(row["id"], admin=True)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header_cookie(token, cookie_name=ADMIN_SESSION_COOKIE)
        body_bytes = json.dumps({"user": safe_user(row)}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def register(self, body):
        role = body.get("role")
        profile = body.get("profile")
        password = body.get("password")
        contact = normalize_contact(body.get("contact"))
        if role not in ("patient", "pharmacy") or not contact or not isinstance(profile, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "بيانات الحساب غير مكتملة.")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+|01[0125]\d{8}", contact):
            raise ApiError(HTTPStatus.BAD_REQUEST, "البريد الإلكتروني أو رقم الموبايل غير صالح.")
        if not isinstance(password, str) or len(password) < 8 or len(password) > 256 or not re.search(r"[a-z]", password) or not re.search(r"[A-Z]", password) or not re.search(r"\d", password):
            raise ApiError(HTTPStatus.BAD_REQUEST, "كلمة المرور يجب أن تكون ٨ أحرف وبها حرف كبير وصغير ورقم.")
        if role == "patient":
            if not profile.get("name") or len(str(profile.get("name"))) > 120 or profile.get("governorate") not in GOVERNORATES or len(str(profile.get("area", ""))) > 120:
                raise ApiError(HTTPStatus.BAD_REQUEST, "الاسم والمحافظة مطلوبان.")
        else:
            required = ("pharmacyName", "license", "phone", "whatsapp", "governorate", "area", "address", "openingTime", "closingTime")
            if any(not profile.get(field) for field in required) or profile.get("governorate") not in GOVERNORATES:
                raise ApiError(HTTPStatus.BAD_REQUEST, "بيانات الصيدلية غير مكتملة.")
            limits = {"pharmacyName": 120, "license": 100, "area": 120, "address": 300}
            if any(len(str(profile.get(field, ""))) > limit for field, limit in limits.items()):
                raise ApiError(HTTPStatus.BAD_REQUEST, "بعض بيانات الصيدلية أطول من المسموح.")
            if not re.fullmatch(r"01[0125]\d{8}", contact):
                raise ApiError(HTTPStatus.BAD_REQUEST, "رقم موبايل الصيدلية غير صالح.")
            opening_time, closing_time = str(profile["openingTime"]), str(profile["closingTime"])
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", opening_time) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", closing_time) or opening_time >= closing_time:
                raise ApiError(HTTPStatus.BAD_REQUEST, "مواعيد العمل غير صالحة.")
            if not re.fullmatch(r"01[0125]\d{8}", normalize_contact(profile.get("whatsapp"))):
                raise ApiError(HTTPStatus.BAD_REQUEST, "رقم واتساب الصيدلية غير صالح.")
            location = profile.get("location")
            if location is not None:
                if not isinstance(location, dict):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "إحداثيات موقع الصيدلية غير صالحة.")
                try:
                    latitude, longitude = float(location["lat"]), float(location["lng"])
                except (KeyError, TypeError, ValueError):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "إحداثيات موقع الصيدلية غير صالحة.")
                if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "إحداثيات موقع الصيدلية خارج النطاق.")
            if not re.fullmatch(r"01[0125]\d{8}", normalize_contact(profile.get("phone"))):
                raise ApiError(HTTPStatus.BAD_REQUEST, "رقم موبايل الصيدلية غير صالح.")
        salt, hashed = password_hash(password)
        user_id = ("pharmacy_" if role == "pharmacy" else "patient_") + secrets.token_hex(12)
        created = now_iso()
        phone = normalize_contact(profile.get("phone")) if role == "pharmacy" else (
            contact if re.fullmatch(r"01[0125]\d{8}", contact) else None
        )
        whatsapp = normalize_contact(profile.get("whatsapp")) if role == "pharmacy" else None
        status = "pending" if role == "pharmacy" else "active"
        profile = {key: value for key, value in profile.items() if key not in ("password", "passwordHash", "passwordSalt", "photo")}
        profile["onboardingComplete"] = True
        contact_points = {contact}
        if phone:
            contact_points.add(phone)
        if whatsapp:
            contact_points.add(whatsapp)
        try:
            with db_connect() as db:
                placeholders = ",".join("?" for _ in contact_points)
                existing = db.execute(
                    f"""SELECT 1 FROM users
                    WHERE role=?
                      AND (contact IN ({placeholders})
                       OR phone IN ({placeholders})
                       OR whatsapp IN ({placeholders}))
                    LIMIT 1""",
                    (role, *contact_points, *contact_points, *contact_points),
                ).fetchone()
                if existing:
                    raise ApiError(HTTPStatus.CONFLICT, "بيانات التواصل مسجلة بالفعل لنوع الحساب ده. استخدمي تسجيل الدخول.")
                db.execute(
                    """INSERT INTO users (id,role,contact,phone,whatsapp,password_salt,password_hash,status,profile,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (user_id, role, contact, phone, whatsapp, salt, hashed, status,
                     json.dumps(profile, ensure_ascii=False), created, created),
                )
                if role == "pharmacy":
                    log_action(db, {"id": user_id, "contact": contact}, "pharmacy_application_submitted", "user", user_id, {
                        "pharmacyName": profile["pharmacyName"], "governorate": profile["governorate"],
                    })
                else:
                    log_action(db, {"id": user_id, "contact": contact}, "patient_account_created", "user", user_id, {
                        "governorate": profile.get("governorate"),
                    })
        except sqlite3.IntegrityError:
            raise ApiError(HTTPStatus.CONFLICT, "بيانات التواصل مسجلة بالفعل لنوع الحساب ده. استخدمي تسجيل الدخول.")
        token = self.set_session(user_id)
        with db_connect() as db:
            row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        self.send_response(HTTPStatus.CREATED)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header_cookie(token)
        body_bytes = json.dumps({"user": safe_user(row)}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def update_profile(self):
        actor = self.require_user()
        body = self.read_json()
        profile = body.get("profile")
        if not isinstance(profile, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "الملف الشخصي غير صالح.")
        allowed = {"name", "governorate", "area", "onboardingComplete", "notificationPreference", "notificationPermission", "location", "requestedMedicineIds", "chronicMedicineIds"}
        if actor["role"] == "pharmacy":
            allowed.add("pharmacyInventory")
        updates = {key: profile[key] for key in allowed if key in profile}
        if "pharmacyInventory" in updates:
            inventory = updates["pharmacyInventory"]
            if not isinstance(inventory, list) or len(inventory) > 200:
                raise ApiError(HTTPStatus.BAD_REQUEST, "قائمة مخزون الصيدلية غير صالحة.")
            normalized_inventory = []
            seen_medicines = set()
            with db_connect() as db:
                for item in inventory:
                    if not isinstance(item, dict):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "بيانات صنف المخزون غير صالحة.")
                    medicine_id = item.get("medicineId")
                    quantity = item.get("quantity")
                    if (isinstance(medicine_id, bool) or not isinstance(medicine_id, int)
                            or medicine_id <= 0 or medicine_id in seen_medicines
                            or isinstance(quantity, bool) or not isinstance(quantity, int)
                            or not 0 <= quantity <= 1_000_000):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "اختاري دواءً مسجلًا وكمية صحيحة من صفر إلى مليون.")
                    if not db.execute("SELECT 1 FROM medicines WHERE id=?", (medicine_id,)).fetchone():
                        raise ApiError(HTTPStatus.BAD_REQUEST, "الدواء المختار غير موجود في دليل دوائي.")
                    seen_medicines.add(medicine_id)
                    normalized_inventory.append({"medicineId": medicine_id, "quantity": quantity})
            updates["pharmacyInventory"] = normalized_inventory
        elif actor["role"] != "pharmacy" and "pharmacyInventory" in profile:
            raise ApiError(HTTPStatus.FORBIDDEN, "إدارة مخزون الصيدلية متاحة لحساب الصيدلية فقط.")
        with db_connect() as db:
            row = db.execute("SELECT profile FROM users WHERE id=?", (actor["id"],)).fetchone()
            current = json.loads(row["profile"])
            current.update(updates)
            db.execute("UPDATE users SET profile=?,updated_at=? WHERE id=?", (json.dumps(current, ensure_ascii=False), now_iso(), actor["id"]))
            saved = db.execute("SELECT * FROM users WHERE id=?", (actor["id"],)).fetchone()
            log_action(db, actor, "profile_updated", "user", actor["id"], {"fields": sorted(updates)})
        return self.json_response(HTTPStatus.OK, {"user": safe_user(saved)})

    def check_login_limit(self, contact):
        with db_connect() as db:
            row = db.execute("SELECT * FROM login_attempts WHERE contact=?", (contact,)).fetchone()
        if row and time.time() - row["window_started"] < 600 and row["attempts"] >= 5:
            raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "محاولات دخول كثيرة. انتظري ١٠ دقائق ثم حاولي مجددًا.")

    def record_login_failure(self, contact):
        current_time = time.time()
        with db_connect() as db:
            row = db.execute("SELECT * FROM login_attempts WHERE contact=?", (contact,)).fetchone()
            if not row or current_time - row["window_started"] >= 600:
                db.execute(
                    "INSERT INTO login_attempts (contact,window_started,attempts) VALUES (?,?,1) ON CONFLICT(contact) DO UPDATE SET window_started=excluded.window_started,attempts=1",
                    (contact, current_time),
                )
            else:
                db.execute("UPDATE login_attempts SET attempts=attempts+1 WHERE contact=?", (contact,))

    def record_login_success(self, contact):
        with db_connect() as db:
            db.execute("DELETE FROM login_attempts WHERE contact=?", (contact,))

    def public_shortages(self):
        with db_connect() as db:
            reports = db.execute(
                """SELECT r.id,r.governorate,r.severity,r.source,r.note,r.created_at,m.id AS medicineId,m.name AS medicineName
                FROM shortage_reports r JOIN medicines m ON m.id=r.medicine_id ORDER BY r.created_at DESC"""
            ).fetchall()
        return self.json_response(HTTPStatus.OK, {"governorates": GOVERNORATES, "reports": [dict(row) for row in reports]})

    def dynamic_catalog(self):
        with db_connect() as db:
            medicines = [dict(row) for row in db.execute(
                """SELECT id,name,arabic_names AS arabicNames,category,unit,quantity,
                stock_status AS stockStatus,minimum,suggested_supply AS suggestedSupply,code FROM medicines ORDER BY id"""
            )]
            seed_pharmacies = [dict(row) for row in db.execute(
                "SELECT id,name,address,phone,governorate FROM pharmacies WHERE source='seed' ORDER BY id"
            )]
            approved = db.execute(
                "SELECT id,profile FROM users WHERE role='pharmacy' AND status='approved' ORDER BY created_at"
            ).fetchall()
        pharmacies = seed_pharmacies
        next_id = max((item["id"] for item in pharmacies), default=0) + 1
        for row in approved:
            profile = json.loads(row["profile"])
            pharmacies.append({
                "id": next_id, "name": profile["pharmacyName"],
                "address": profile["governorate"] + " - " + profile["area"] + " - " + profile["address"],
                "phone": profile["phone"], "whatsapp": profile["whatsapp"],
                "openingTime": profile["openingTime"], "closingTime": profile["closingTime"],
                "governorate": profile["governorate"],
            })
            next_id += 1
        payload = json.dumps({"source": "dawaey-central-database", "medicines": medicines, "pharmacies": pharmacies}, ensure_ascii=False)
        encoded = ("window.DAWAEY_DATA = " + payload + ";\n").encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def admin_overview(self):
        with db_connect() as db:
            users = [safe_user(row) for row in db.execute(
                "SELECT * FROM users WHERE role!='admin' ORDER BY created_at DESC"
            )]
            medicines = [dict(row) for row in db.execute(
                """SELECT id,name,arabic_names AS arabicNames,category,unit,quantity,
                stock_status AS stockStatus,minimum,suggested_supply AS suggestedSupply,code FROM medicines ORDER BY name COLLATE NOCASE"""
            )]
            reports = [dict(row) for row in db.execute(
                """SELECT r.id,r.governorate,r.severity,r.source,r.note,r.created_at AS createdAt,
                m.id AS medicineId,m.name AS medicineName FROM shortage_reports r
                JOIN medicines m ON m.id=r.medicine_id ORDER BY r.created_at DESC"""
            )]
            audit = [dict(row) for row in db.execute(
                """SELECT id,actor_id AS actorId,actor_contact AS actorContact,action,target_type AS targetType,
                target_id AS targetId,details,created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT 200"""
            )]
        for row in audit:
            row["details"] = json.loads(row["details"])
        return self.json_response(HTTPStatus.OK, {
            "users": users, "medicines": medicines, "reports": reports,
            "audit": audit, "governorates": GOVERNORATES,
        })

    def review_pharmacy(self, user_id, body, actor):
        decision = body.get("decision")
        reason = str(body.get("reason", "")).strip()
        if decision not in ("approved", "rejected") or (decision == "rejected" and not reason):
            raise ApiError(HTTPStatus.BAD_REQUEST, "اختاري القبول أو الرفض مع كتابة سبب الرفض.")
        with db_connect() as db:
            row = db.execute("SELECT * FROM users WHERE id=? AND role='pharmacy'", (user_id,)).fetchone()
            if not row:
                raise ApiError(HTTPStatus.NOT_FOUND, "طلب الصيدلية غير موجود.")
            db.execute(
                "UPDATE users SET status=?,rejection_reason=?,updated_at=? WHERE id=?",
                (decision, reason if decision == "rejected" else None, now_iso(), user_id),
            )
            log_action(db, actor, "pharmacy_" + decision, "user", user_id, {
                "pharmacyName": json.loads(row["profile"]).get("pharmacyName"), "reason": reason,
            })
            updated = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return self.json_response(HTTPStatus.OK, {"user": safe_user(updated)})

    def update_user(self, user_id, body, actor):
        status = body.get("status")
        if user_id == actor["id"]:
            raise ApiError(HTTPStatus.BAD_REQUEST, "لا يمكن إيقاف حساب الإدارة المستخدم.")
        with db_connect() as db:
            row = db.execute("SELECT * FROM users WHERE id=? AND role!='admin'", (user_id,)).fetchone()
            if not row:
                raise ApiError(HTTPStatus.NOT_FOUND, "الحساب غير موجود.")
            permitted = ("approved", "suspended") if row["role"] == "pharmacy" else ("active", "suspended")
            if status not in permitted:
                raise ApiError(HTTPStatus.BAD_REQUEST, "حالة الحساب غير صالحة.")
            db.execute("UPDATE users SET status=?,updated_at=? WHERE id=?", (status, now_iso(), user_id))
            if status == "suspended":
                db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            log_action(db, actor, "user_status_changed", "user", user_id, {"from": row["status"], "to": status})
            updated = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return self.json_response(HTTPStatus.OK, {"user": safe_user(updated)})

    def update_medicine(self, medicine_id, body, actor):
        name = str(body.get("name", "")).strip()
        arabic_names = body.get("arabicNames", "")
        category = str(body.get("category", "")).strip()
        if not name or len(name) > 120 or not isinstance(arabic_names, str) or len(arabic_names) > 500 or not category or len(category) > 120:
            raise ApiError(HTTPStatus.BAD_REQUEST, "اسم الدواء والتصنيف والأسماء العربية مطلوبة.")
        try:
            quantity = max(0, int(body.get("quantity", 0)))
            minimum = max(0, int(body.get("minimum", 0)))
        except (ValueError, TypeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "الكميات يجب أن تكون أرقامًا صحيحة غير سالبة.")
        with db_connect() as db:
            row = db.execute("SELECT * FROM medicines WHERE id=?", (medicine_id,)).fetchone()
            if not row:
                raise ApiError(HTTPStatus.NOT_FOUND, "الدواء غير موجود.")
            before = {"name": row["name"], "arabicNames": row["arabic_names"], "category": row["category"], "quantity": row["quantity"], "minimum": row["minimum"]}
            db.execute(
                """UPDATE medicines SET name=?,arabic_names=?,category=?,quantity=?,minimum=? WHERE id=?""",
                (name, arabic_names, category, quantity, minimum, medicine_id),
            )
            log_action(db, actor, "medicine_updated", "medicine", medicine_id, {
                "before": before, "after": {"name": name, "arabicNames": arabic_names, "category": category, "quantity": quantity, "minimum": minimum},
            })
        return self.json_response(HTTPStatus.OK, {"ok": True})

    def create_report(self, body, actor):
        medicine_id = body.get("medicineId")
        governorate = body.get("governorate")
        severity = body.get("severity")
        source = str(body.get("source", "")).strip()
        note = str(body.get("note", "")).strip()
        if governorate not in GOVERNORATES or severity not in ("shortage", "unavailable") or not source or len(source) > 180 or len(note) > 500:
            raise ApiError(HTTPStatus.BAD_REQUEST, "راجعي المحافظة ونوع النقص والمصدر.")
        report_id = "report_" + secrets.token_hex(12)
        with db_connect() as db:
            if not db.execute("SELECT 1 FROM medicines WHERE id=?", (medicine_id,)).fetchone():
                raise ApiError(HTTPStatus.BAD_REQUEST, "اختاري دواءً من قاعدة البيانات.")
            db.execute(
                """INSERT INTO shortage_reports (id,medicine_id,governorate,severity,source,note,reporter_id,created_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                (report_id, int(medicine_id), governorate, severity, source, note, actor["id"], now_iso()),
            )
            log_action(db, actor, "shortage_report_added", "shortage_report", report_id, {
                "medicineId": int(medicine_id), "governorate": governorate, "severity": severity, "source": source,
            })
        return self.json_response(HTTPStatus.CREATED, {"id": report_id})


def serve():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    initialize_database()
    host = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer((host, port), DawaeyHandler)
    server.daemon_threads = True
    print(f"Dawaey is listening on http://{host}:{port}")
    if not os.environ.get("DAWAEY_ADMIN_EMAIL") or not os.environ.get("DAWAEY_ADMIN_PASSWORD"):
        print("Warning: No admin was created. Set DAWAEY_ADMIN_EMAIL and DAWAEY_ADMIN_PASSWORD before admin login.")
    server.serve_forever()


def create_admin():
    initialize_database()
    email = normalize_contact(input("Admin email: "))
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise SystemExit("Enter a valid email address.")
    with db_connect() as db:
        if db.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone():
            raise SystemExit("An admin account already exists. Do not reset it through this command.")
    password = getpass.getpass("Admin password (12+ chars, upper/lowercase and number): ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise SystemExit("Passwords do not match.")
    if len(password) < 12 or not re.search(r"[a-z]", password) or not re.search(r"[A-Z]", password) or not re.search(r"\d", password):
        raise SystemExit("Password must be at least 12 characters and include uppercase, lowercase, and a number.")
    salt, hashed = password_hash(password)
    with db_connect() as db:
        db.execute(
            """INSERT INTO users (id,role,contact,password_salt,password_hash,status,profile,created_at,updated_at)
            VALUES (?,'admin',?,?,?,'active',?,?,?)""",
            ("admin_" + secrets.token_hex(12), email, salt, hashed,
             json.dumps({"name": "إدارة دوائي"}, ensure_ascii=False), now_iso(), now_iso()),
        )
    print("Admin account created. Keep the credentials private.")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "create-admin":
        create_admin()
    else:
        serve()
