/**
 * AUTOMATED REASSIGNMENT SCRIPT (ROOT VERSION)
 * - Matches autoDeclineRunner.js logic EXACTLY
 * - Uses local service-account.json
 * - Applies Sanity rotation
 * - Filters by reading language + rank
 * - Creates new Sanity service doc for replacement
 * - Updates Firestore
 * - Sends push notifications
 */

const admin = require("firebase-admin");
const { createClient } = require("@sanity/client");
const serviceAccount = require("./service-account.json");

/* ---------------------------------------------------------
   1️⃣ Initialize Firebase Admin (root version)
--------------------------------------------------------- */
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

/* ---------------------------------------------------------
   2️⃣ Initialize Sanity Client
--------------------------------------------------------- */
const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  token: process.env.SANITY_WRITE_TOKEN,
  apiVersion: "2023-05-03",
  useCdn: false,
});

/* ---------------------------------------------------------
   3️⃣ Rotation function (from your original logic)
--------------------------------------------------------- */
const getFinalDeaconsArray = (mainArray, serviceArray, selectedRank) => {
  const remaining = mainArray.filter(
    (d) => !serviceArray.some((sd) => sd.deaconName === d.deaconName)
  );

  const shuffledRemaining = remaining.length > 0 ? [...remaining] : [...serviceArray];
  for (let i = shuffledRemaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledRemaining[i], shuffledRemaining[j]] = [
      shuffledRemaining[j],
      shuffledRemaining[i],
    ];
  }

  let shuffledAndRanked = [];
  if (selectedRank === "Any") {
    shuffledAndRanked = [...shuffledRemaining];
  } else {
    shuffledAndRanked = shuffledRemaining.filter(
      (d) => d.deaconRank?.rankName === selectedRank
    );
  }

  const served = mainArray.filter((d) =>
    serviceArray.some((sd) => sd.deaconName === d.deaconName)
  );

  let servedRanked = [];
  if (selectedRank === "Any") {
    servedRanked = [...served];
  } else {
    servedRanked = served.filter(
      (d) => d.deaconRank?.rankName === selectedRank
    );
  }

  return [...shuffledAndRanked, ...servedRanked];
};

/* ---------------------------------------------------------
   4️⃣ Reassignment logic
--------------------------------------------------------- */
async function reassignDeacon(assignmentDoc) {
  const assignment = assignmentDoc.data();
  console.log("\n🔄 Reassigning service:", assignment.sanityDocId);

  // STEP 1 — get original Sanity doc
  const original = await sanityClient.fetch(
    `*[_type=="service" && _id==$id][0]{
      serviceDate,
      serviceDay,
      mainEvent,
      subEvent,
      prayer,

      reading->{ _id, readingName },
      language->{ _id, language },
      deaconRank->{ _id, rankName }
    }`,
    { id: assignment.sanityDocId }
  );

  if (!original) {
    console.log("❌ Original Sanity doc not found:", assignment.sanityDocId);
    return;
  }

  const {
    serviceDate,
    mainEvent,
    subEvent,
    prayer,
    reading,
    language,
    deaconRank,
  } = original;

  // STEP 2 — load all deacons
  const allDeacons = await sanityClient.fetch(`
    *[_type == "deacon"]{
      _id,
      deaconName,
      email,
      phone,
      readinglanguage,
      deaconRank->{rankName},
      "rankId": deaconRank._ref,
      expoPushToken
    }
  `);

  // STEP 3 — filter by reading language
  const requiredLang = (language?.language || "").trim().toUpperCase();

  const eligibleByLanguage = allDeacons.filter((d) =>
    (d.readinglanguage?.language || "").trim().toUpperCase() === requiredLang
  );

  if (eligibleByLanguage.length === 0) {
    console.log("❌ No deacons match required language:", requiredLang);
    return;
  }

  // STEP 4 — retrieve service history for rotation
  const history = await sanityClient.fetch(`
    *[_type == "service"] | order(_createdAt asc){
      _createdAt,
      deaconName
    }
  `);

  // STEP 5 — rotation + rank filtering
  const nextList = getFinalDeaconsArray(
    eligibleByLanguage,
    history,
    deaconRank?.rankName || "Any"
  );

  const nextDeacon = nextList[0];
  if (!nextDeacon) {
    console.log("❌ No eligible replacement found.");
    return;
  }

  console.log("👉 Replacement selected:", nextDeacon.deaconName);

  // STEP 6 — create NEW Sanity service doc
  const newDoc = await sanityClient.create({
    _type: "service",

    serviceDate,
    serviceDay: new Date(serviceDate).toLocaleDateString("en-US", {
      weekday: "long",
    }),

    mainEvent,
    subEvent,
    prayer,

    reading: { _ref: reading._id, _type: "reference" },
    language: { _ref: language._id, _type: "reference" },

    deacon: { _ref: nextDeacon._id, _type: "reference" },
    deaconName: nextDeacon.deaconName,
    deaconRank: { _ref: nextDeacon.rankId, _type: "reference" },

    phone: nextDeacon.phone,
    email: nextDeacon.email,

    isAccepted: null,
    isRejected: null,
    noResponse: null,
    hasAttended: null,
  });

  console.log("🆕 New replacement Sanity doc:", newDoc._id);

  // STEP 7 — create Firestore assignment
  const newFSId = `${newDoc._id}_${nextDeacon._id}`;

  await db.collection("ServiceAssignments").doc(newFSId).set({
    sanityDocId: newDoc._id,
    serviceDate,

    readingRefId: reading._id,
    languageRefId: language._id,
    rankFilter: deaconRank.rankName,

    deaconId: nextDeacon._id,
    deaconName: nextDeacon.deaconName,
    email: nextDeacon.email,
    expoPushToken: nextDeacon.expoPushToken || null,

    status: "pending",
    invitedAt: Date.now(),
    expiresAt: Date.now() + 48 * 60 * 60 * 1000,
  });

  console.log("📌 Firestore entry created:", newFSId);

  // STEP 8 — send push notification
  if (nextDeacon.expoPushToken) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: nextDeacon.expoPushToken,
        title: "New Service Assignment",
        body: `You have been assigned a replacement service.`,
        data: { sanityDocId: newDoc._id },
      }),
    });

    console.log("📨 Push sent to:", nextDeacon.deaconName);
  }

  console.log("✅ Reassignment completed.");
}

/* ---------------------------------------------------------
   5️⃣ MAIN SCRIPT — Auto-decline + Reassign
   (Matches old autoDeclineRunner.js + adds reassignment step)
--------------------------------------------------------- */
(async () => {
  console.log("⏳ Checking for expired and declined assignments...");

  const now = Date.now();

  // 1️⃣ Auto-expired assignments (pending + past expiry)
  const expired = await db
    .collection("ServiceAssignments")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .get();

  // 2️⃣ User-declined assignments (declined + not reassigned yet)
  const declined = await db
    .collection("ServiceAssignments")
    .where("status", "==", "declined")
    .where("reassigned", "==", false)
    .get();

  if (expired.empty && declined.empty) {
    console.log("✨ No assignments to process.");
    return;
  }

  console.log(`⚠ Found ${expired.size} expired, ${declined.size} declined assignments.`);

  // Process auto-expired first
  for (const doc of expired.docs) {
    const assignment = doc.data();

    // 1️⃣ Mark as declined (just like old script)
    await doc.ref.update({
      status: "declined",
      respondedAt: now,
      reassigned: false,  // important default
    });

    // 2️⃣ Mark Sanity record
    await sanityClient.patch(assignment.sanityDocId)
      .set({ noResponse: true })
      .commit();

    console.log(`📝 Sanity updated (auto-expired): ${assignment.sanityDocId}`);

    // 3️⃣ Reassign
    await reassignDeacon(doc);

    // 4️⃣ Prevent reassigning twice
    await doc.ref.update({ reassigned: true });
  }

  // Process user-declined
  for (const doc of declined.docs) {
    const assignment = doc.data();

    console.log(`🙅 User-declined service: ${assignment.sanityDocId}`);

    // 1️⃣ Sanity was already set to isRejected on app side, but ensure noResponse not set:
    await sanityClient.patch(assignment.sanityDocId)
      .set({ isRejected: true })
      .commit();

    // 2️⃣ Reassign
    await reassignDeacon(doc);

    // 3️⃣ Mark Firestore as processed
    await doc.ref.update({ reassigned: true });

    console.log(`🔁 Replacement issued for user-declined: ${assignment.sanityDocId}`);
  }

  console.log("🏁 All expired + declined assignments processed.");
})();
