import http.cookiejar
import json
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener
from pathlib import Path

import server


class AdminApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.original_db = server.DB_PATH
        server.DB_PATH = Path(cls.temp_dir.name) / "test.sqlite3"
        server.initialize_database()
        salt, hashed = server.password_hash("AdminPass123456")
        with server.db_connect() as db:
            db.execute(
                """INSERT INTO users (id,role,contact,password_salt,password_hash,status,profile,created_at,updated_at)
                VALUES ('admin-test','admin','admin@example.test',?,?,'active','{"name":"اختبار"}',?,?)""",
                (salt, hashed, server.now_iso(), server.now_iso()),
            )
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.DawaeyHandler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"
        cls.admin = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        cls.patient = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=3)
        server.DB_PATH = cls.original_db
        cls.temp_dir.cleanup()

    def api(self, opener, path, method="GET", body=None, expected=200):
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = Request(
            self.base + path,
            data=payload,
            method=method,
            headers={"Content-Type": "application/json"} if payload is not None else {},
        )
        try:
            with opener.open(request) as response:
                status = response.status
                result = json.loads(response.read())
        except HTTPError as error:
            status = error.code
            result = json.loads(error.read())
            error.close()
        self.assertEqual(status, expected, result)
        return result

    def test_protected_admin_pharmacy_reviews_catalog_shortages_and_audit(self):
        denied = self.api(build_opener(), "/api/admin/overview", expected=401)
        self.assertIn("error", denied)
        self.api(self.admin, "/api/admin/login", "POST", {
            "contact": "admin@example.test", "password": "AdminPass123456",
        })
        self.api(self.admin, "/api/admin/overview")
        self.api(self.admin, "/api/auth/session", expected=401)

        pharmacy = self.api(self.patient, "/api/auth/register", "POST", {
            "role": "pharmacy", "contact": "01012345678", "password": "PharmacyPass123",
            "profile": {
                "pharmacyName": "صيدلية اختبار",
                "license": "LIC-1", "phone": "01012345678", "whatsapp": "01012345679",
                "governorate": "القاهرة", "area": "المعادي", "address": "شارع الاختبار",
                "openingTime": "09:00", "closingTime": "22:00",
            },
        }, expected=201)["user"]
        self.assertEqual(pharmacy["status"], "pending")
        self.assertNotIn("pharmacistName", pharmacy)
        self.assertNotIn("photo", pharmacy)
        self.api(self.patient, "/api/admin/overview", expected=401)
        self.api(self.admin, f"/api/admin/pharmacies/{pharmacy['id']}", "PATCH", {
            "decision": "rejected", "reason": "",
        }, expected=400)
        self.api(self.admin, f"/api/admin/pharmacies/{pharmacy['id']}", "PATCH", {
            "decision": "rejected", "reason": "يرجى استكمال الترخيص.",
        })
        overview = self.api(self.admin, "/api/admin/overview")
        reviewed = next(user for user in overview["users"] if user["id"] == pharmacy["id"])
        self.assertEqual(reviewed["status"], "rejected")
        self.assertEqual(reviewed["rejectionReason"], "يرجى استكمال الترخيص.")

        self.api(self.admin, "/api/admin/medicines/1", "PATCH", {
            "name": "Panadol", "arabicNames": "بانادول، بنادول", "category": "مسكن",
            "quantity": 100, "minimum": 10,
        })
        catalog = self.api(build_opener(), "/api/shortages")
        self.assertEqual(catalog["reports"], [])
        script = self.api(build_opener(), "/api/admin/overview", expected=401)
        self.assertIn("error", script)
        with self.admin.open(self.base + "/data.js") as response:
            data_script = response.read().decode("utf-8")
        self.assertIn("بانادول، بنادول", data_script)

        self.api(self.admin, "/api/admin/reports", "POST", {
            "medicineId": 1, "governorate": "القاهرة", "severity": "unavailable",
            "source": "نشرة تحقق 2026-10-04", "note": "تم تأكيد البلاغ.",
        }, expected=201)
        reports = self.api(build_opener(), "/api/shortages")["reports"]
        self.assertEqual(reports[0]["governorate"], "القاهرة")
        self.assertEqual(reports[0]["severity"], "unavailable")
        overview = self.api(self.admin, "/api/admin/overview")
        self.assertIn("pharmacy_rejected", [item["action"] for item in overview["audit"]])
        self.assertIn("medicine_updated", [item["action"] for item in overview["audit"]])
        self.assertIn("shortage_report_added", [item["action"] for item in overview["audit"]])

    def test_patient_account_and_arabic_aliases(self):
        result = self.api(self.patient, "/api/auth/register", "POST", {
            "role": "patient", "contact": "patient@example.test", "password": "PatientPass123",
            "profile": {"name": "مريض اختبار", "governorate": "الجيزة", "area": "الدقي"},
        }, expected=201)
        self.assertEqual(result["user"]["role"], "patient")
        self.assertTrue(result["user"]["onboardingComplete"])
        session = self.api(self.patient, "/api/auth/session")
        self.assertEqual(session["user"]["contact"], "patient@example.test")
        self.api(self.patient, "/api/auth/logout", "POST", {})
        self.api(self.patient, "/api/auth/session", expected=401)
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "patient@example.test", "password": "PatientPass123",
            "expectedRole": "patient",
        })
        session = self.api(self.patient, "/api/auth/session")
        self.assertEqual(session["user"]["contact"], "patient@example.test")
        self.assertEqual(session["user"]["name"], "مريض اختبار")
        self.api(self.patient, "/api/auth/logout", "POST", {})
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "patient@example.test", "password": "PatientPass123",
            "expectedRole": "pharmacy",
        }, expected=403)
        self.api(self.patient, "/api/auth/session", expected=401)
        self.assertEqual(server.normalize_contact("٠١٠١٢٣٤٥٦٧٨"), "01012345678")
        self.assertEqual(server.ARABIC_ALIASES["Panadol"], "بانادول")
        self.api(self.patient, "/api/auth/register", "POST", {
            "role": "patient", "contact": "01023456789", "password": "PatientPass123",
            "profile": {"name": "مستخدم اختبار", "governorate": "الجيزة"},
        }, expected=201)
        self.api(self.patient, "/api/auth/register", "POST", {
            "role": "pharmacy", "contact": "01034567890", "password": "PharmacyPass123",
            "profile": {
                "pharmacyName": "صيدلية مكررة", "license": "LIC-DUP",
                "phone": "01034567890", "whatsapp": "٠١٠٢٣٤٥٦٧٨٩",
                "governorate": "القاهرة", "area": "المعادي", "address": "شارع الاختبار",
                "openingTime": "09:00", "closingTime": "22:00",
            },
        }, expected=201)
        self.api(self.patient, "/api/auth/register", "POST", {
            "role": "pharmacy", "contact": "01034567891", "password": "PharmacyPass123",
            "profile": {
                "pharmacyName": "صيدلية واتساب مكرر", "license": "LIC-DUP-2",
                "phone": "01034567891", "whatsapp": "01023456789",
                "governorate": "القاهرة", "area": "المعادي", "address": "شارع الاختبار",
                "openingTime": "09:00", "closingTime": "22:00",
            },
        }, expected=409)
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "patient@example.test", "password": "PatientPass123",
        })
        self.api(self.admin, "/api/admin/login", "POST", {
            "contact": "admin@example.test", "password": "AdminPass123456",
        })
        self.api(self.admin, f"/api/admin/users/{result['user']['id']}", "PATCH", {"status": "suspended"})
        self.api(self.patient, "/api/auth/session", expected=401)
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "patient@example.test", "password": "PatientPass123",
        }, expected=403)

    def test_photo_and_map_are_optional_for_pharmacy_registration(self):
        patient = self.api(self.patient, "/api/auth/register", "POST", {
            "role": "patient", "contact": "01045678901", "password": "PatientPass123",
            "profile": {
                "name": "مريض الحساب المشترك", "governorate": "الجيزة",
                "area": "الدقي", "requestedMedicineIds": [1],
            },
        }, expected=201)["user"]
        self.api(self.patient, "/api/auth/logout", "POST", {})
        pharmacy = self.api(self.patient, "/api/auth/register", "POST", {
            "role": "pharmacy", "contact": "01045678901", "password": "PharmacyPass123",
            "profile": {
                "pharmacyName": "صيدلية الاسم الكامل للاختبار", "license": "LIC-FULL-1",
                "phone": "01045678901", "whatsapp": "01045678902",
                "governorate": "القاهرة", "area": "المعادي", "address": "شارع النصر، مبنى ١",
                "openingTime": "09:00", "closingTime": "22:00",
            },
        }, expected=201)["user"]
        self.assertNotEqual(patient["id"], pharmacy["id"])
        self.assertEqual(pharmacy["status"], "pending")
        self.assertNotIn("photo", pharmacy)
        self.api(self.patient, "/api/auth/logout", "POST", {})
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01045678901", "password": "PatientPass123",
            "expectedRole": "pharmacy",
        }, expected=403)
        self.api(self.patient, "/api/auth/session", expected=401)
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01045678901", "password": "PharmacyPass123",
            "expectedRole": "patient",
        }, expected=403)
        self.api(self.patient, "/api/auth/session", expected=401)
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01045678901", "password": "PatientPass123",
        }, expected=400)
        self.api(self.patient, "/api/auth/session", expected=401)
        patient_login = self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01045678901", "password": "PatientPass123",
            "expectedRole": "patient",
        })["user"]
        self.assertEqual(patient_login["id"], patient["id"])
        self.assertEqual(patient_login["name"], "مريض الحساب المشترك")
        self.assertEqual(patient_login["area"], "الدقي")
        self.assertEqual(patient_login["requestedMedicineIds"], [1])
        self.assertNotIn("pharmacyName", patient_login)
        self.api(self.patient, "/api/profile", "PUT", {
            "profile": {"pharmacyInventory": [{"medicineId": 1, "quantity": 3}]},
        }, expected=403)
        self.api(self.patient, "/api/auth/logout", "POST", {})
        logged_in = self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01045678901", "password": "PharmacyPass123",
            "expectedRole": "pharmacy",
        })["user"]
        self.assertEqual(logged_in["id"], pharmacy["id"])
        self.assertEqual(logged_in["pharmacyName"], "صيدلية الاسم الكامل للاختبار")
        self.assertEqual(logged_in["area"], "المعادي")
        self.assertEqual(logged_in["status"], "pending")
        inventory_response = self.api(self.patient, "/api/profile", "PUT", {
            "profile": {"pharmacyInventory": [{"medicineId": 1, "quantity": 7}, {"medicineId": 2, "quantity": 0}]},
        })["user"]
        self.assertEqual(inventory_response["pharmacyInventory"], [
            {"medicineId": 1, "quantity": 7}, {"medicineId": 2, "quantity": 0},
        ])
        self.api(self.patient, "/api/profile", "PUT", {
            "profile": {"pharmacyInventory": [{"medicineId": 99999, "quantity": 1}]},
        }, expected=400)
        self.api(self.patient, "/api/profile", "PUT", {
            "profile": {"pharmacyInventory": [{"medicineId": 1, "quantity": -1}]},
        }, expected=400)
        self.api(self.patient, "/api/auth/logout", "POST", {})
        restored = self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01045678901", "password": "PharmacyPass123",
            "expectedRole": "pharmacy",
        })["user"]
        self.assertEqual(restored["pharmacyInventory"], inventory_response["pharmacyInventory"])
        self.api(self.admin, "/api/admin/login", "POST", {
            "contact": "admin@example.test", "password": "AdminPass123456",
        })
        self.api(self.admin, f"/api/admin/pharmacies/{pharmacy['id']}", "PATCH", {
            "decision": "approved",
        })
        inventory_notice = next(
            item for item in self.api(self.admin, "/api/admin/overview")["notifications"]
            if item["kind"] == "pharmacy_inventory_updated"
            and item["relatedId"] == pharmacy["id"]
        )
        self.assertIn("صيدلية الاسم الكامل للاختبار", inventory_notice["message"])
        self.assertIn("7", inventory_notice["message"])
        self.assertIn("Panadol", inventory_notice["message"])
        notification_count = self.api(self.admin, "/api/admin/overview")["notifications"]
        self.assertEqual(
            sum(item["kind"] == "pharmacy_inventory_updated" and item["relatedId"] == pharmacy["id"]
                for item in notification_count),
            1,
        )
        with self.admin.open(self.base + "/data.js") as response:
            data_script = response.read().decode("utf-8")
        catalog = json.loads(data_script.removeprefix("window.DAWAEY_DATA = ").rstrip().removesuffix(";"))
        listed = next(item for item in catalog["pharmacies"] if item["name"] == "صيدلية الاسم الكامل للاختبار")
        self.assertEqual(listed["whatsapp"], "01045678902")
        self.assertEqual(listed["openingTime"], "09:00")
        self.assertEqual(listed["closingTime"], "22:00")

    def test_patient_orders_reach_approved_pharmacy_and_notify_each_party(self):
        patient = self.api(self.patient, "/api/auth/register", "POST", {
            "role": "patient", "contact": "01056789012", "password": "PatientPass123",
            "profile": {"name": "مريضة الحجز", "governorate": "القاهرة", "area": "المعادي"},
        }, expected=201)["user"]
        self.api(self.patient, "/api/auth/logout", "POST", {})
        pharmacy = self.api(self.patient, "/api/auth/register", "POST", {
            "role": "pharmacy", "contact": "01056789013", "password": "PharmacyPass123",
            "profile": {
                "pharmacyName": "صيدلية الحجز", "license": "LIC-ORDER-1",
                "phone": "01056789013", "whatsapp": "01056789014",
                "governorate": "القاهرة", "area": "المعادي", "address": "شارع الحجز",
                "openingTime": "09:00", "closingTime": "22:00",
            },
        }, expected=201)["user"]
        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01056789012", "password": "PatientPass123", "expectedRole": "patient",
        })
        self.api(self.patient, "/api/orders", "POST", {
            "medicineId": 1, "pharmacyId": pharmacy["id"], "quantity": 1,
        }, expected=400)
        self.api(self.patient, "/api/auth/logout", "POST", {})
        self.api(self.admin, "/api/admin/login", "POST", {
            "contact": "admin@example.test", "password": "AdminPass123456",
        })
        self.api(self.admin, f"/api/admin/pharmacies/{pharmacy['id']}", "PATCH", {
            "decision": "approved", "reason": "",
        })
        reviewed_pharmacy = next(
            user for user in self.api(self.admin, "/api/admin/overview")["users"]
            if user["id"] == pharmacy["id"]
        )
        self.assertEqual(reviewed_pharmacy["license"], "LIC-ORDER-1")
        self.assertEqual(reviewed_pharmacy["phone"], "01056789013")
        self.assertEqual(reviewed_pharmacy["whatsapp"], "01056789014")
        self.assertEqual(reviewed_pharmacy["address"], "شارع الحجز")
        self.assertEqual(reviewed_pharmacy["openingTime"], "09:00")
        self.assertEqual(reviewed_pharmacy["closingTime"], "22:00")

        pharmacy_session = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.api(pharmacy_session, "/api/auth/login", "POST", {
            "contact": "01056789013", "password": "PharmacyPass123", "expectedRole": "pharmacy",
        })
        approval_notifications = self.api(pharmacy_session, "/api/notifications")["notifications"]
        approval_notice = next(item for item in approval_notifications if item["kind"] == "pharmacy_approved")
        self.assertIn("تم اعتماد طلب تسجيل الصيدلية", approval_notice["message"])

        with self.admin.open(self.base + "/data.js") as response:
            self.assertIn(f'"accountId": "{pharmacy["id"]}"', response.read().decode("utf-8"))

        self.api(self.patient, "/api/auth/login", "POST", {
            "contact": "01056789012", "password": "PatientPass123", "expectedRole": "patient",
        })
        created = self.api(self.patient, "/api/orders", "POST", {
            "medicineId": 1, "pharmacyId": pharmacy["id"], "quantity": 2,
            "note": "يرجى تأكيد التوفر.",
        }, expected=201)["order"]
        self.assertEqual(created["status"], "pending")
        self.assertEqual(created["pharmacyName"], "صيدلية الحجز")
        self.assertNotIn("patientContact", created)
        self.api(self.patient, "/api/orders", "POST", {
            "medicineId": 1, "pharmacyId": "seed-pharmacy-not-linked", "quantity": 1,
        }, expected=400)
        admin_overview = self.api(self.admin, "/api/admin/overview")
        self.assertEqual(admin_overview["orders"][0]["id"], created["id"])
        self.assertIn("01030607046", admin_overview["adminWhatsApp"])
        pharmacy_notice = next(
            item for item in admin_overview["notifications"]
            if item["relatedId"] == created["id"] and item["kind"] == "order_created"
        )
        self.assertTrue(any(
            item["kind"] == "pharmacy_application"
            and item["relatedId"] == pharmacy["id"]
            for item in admin_overview["notifications"]
        ))
        self.api(self.admin, f"/api/admin/notifications/{pharmacy_notice['id']}", "PATCH", {"read": True})

        incoming = self.api(pharmacy_session, "/api/orders")["orders"]
        self.assertEqual(incoming[0]["id"], created["id"])
        self.assertEqual(incoming[0]["patientContact"], "01056789012")
        self.api(pharmacy_session, f"/api/orders/{created['id']}", "PATCH", {"status": "accepted"})
        patient_orders = self.api(self.patient, "/api/orders")["orders"]
        self.assertEqual(patient_orders[0]["status"], "accepted")
        self.assertEqual(patient_orders[0]["pharmacyPhone"], "01056789013")
        notifications = self.api(self.patient, "/api/notifications")["notifications"]
        accepted_notice = next(item for item in notifications if item["kind"] == "order_accepted")
        self.api(self.patient, f"/api/notifications/{accepted_notice['id']}", "PATCH", {"read": True})
        self.api(self.patient, f"/api/orders/{created['id']}", "PATCH", {"status": "cancelled"})
        self.api(pharmacy_session, f"/api/orders/{created['id']}", "PATCH", {"status": "fulfilled"}, expected=409)
        self.assertEqual(self.api(self.patient, "/api/orders")["orders"][0]["status"], "cancelled")

    def test_login_attempts_are_rate_limited(self):
        for _ in range(5):
            self.api(build_opener(), "/api/auth/login", "POST", {
                "contact": "locked@example.test", "password": "WrongPass123",
            }, expected=401)
        self.api(build_opener(), "/api/auth/login", "POST", {
            "contact": "locked@example.test", "password": "WrongPass123",
        }, expected=429)

    def test_database_migrates_existing_user_data_for_role_scoped_contacts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            original_db = server.DB_PATH
            server.DB_PATH = Path(temp_dir) / "legacy.sqlite3"
            try:
                legacy_db = sqlite3.connect(server.DB_PATH)
                try:
                    legacy_db.executescript("""
                        CREATE TABLE users (
                            id TEXT PRIMARY KEY,
                            role TEXT NOT NULL CHECK (role IN ('patient','pharmacy','admin')),
                            contact TEXT NOT NULL UNIQUE,
                            phone TEXT UNIQUE,
                            whatsapp TEXT UNIQUE,
                            password_salt TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            status TEXT NOT NULL DEFAULT 'active',
                            profile TEXT NOT NULL,
                            rejection_reason TEXT,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL
                        );
                        CREATE TABLE sessions (
                            token_hash TEXT PRIMARY KEY,
                            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            expires_at TEXT NOT NULL
                        );
                        INSERT INTO users VALUES (
                            'legacy-patient','patient','01045678901','01045678901',NULL,
                            'salt','hash','active','{"name":"بيانات مريض قديمة"}',NULL,
                            '2026-01-01','2026-01-01'
                        );
                        INSERT INTO sessions VALUES ('legacy-session','legacy-patient','2099-01-01');
                    """)
                finally:
                    legacy_db.close()

                server.initialize_database()
                with server.db_connect() as db:
                    preserved = db.execute("SELECT * FROM users WHERE id='legacy-patient'").fetchone()
                    self.assertEqual(json.loads(preserved["profile"])["name"], "بيانات مريض قديمة")
                    self.assertEqual(db.execute("SELECT user_id FROM sessions WHERE token_hash='legacy-session'").fetchone()["user_id"], "legacy-patient")
                    db.execute(
                        """INSERT INTO users
                        (id,role,contact,phone,password_salt,password_hash,status,profile,created_at,updated_at)
                        VALUES ('new-pharmacy','pharmacy','01045678901','01045678901','salt','hash',
                        'pending','{"pharmacyName":"صيدلية منفصلة"}','2026-01-02','2026-01-02')"""
                    )
                    self.assertEqual(
                        db.execute("SELECT COUNT(*) FROM users WHERE contact='01045678901'").fetchone()[0],
                        2,
                    )
                    self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            finally:
                server.DB_PATH = original_db


if __name__ == "__main__":
    unittest.main()
