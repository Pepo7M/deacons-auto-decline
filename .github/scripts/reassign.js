/**
 * FULL AUTOMATED REASSIGNMENT SCRIPT
 * Runs via GitHub Actions every 5 minutes
 * Rotation from SANITY
 * Replacement based on SAME rank + SAME reading language
 */

console.log("🔥 RUNNING github/scripts/reassign.js");

const admin = require("firebase-admin");
const fetch = require("node-fetch");
const { createClient } = require("@sanity/client");

// -----------------------------------------------------------------------------
// 1️⃣ Initialize Firebase Admin SDK
// -----------------------------------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// -----------------------------------------------------------------------------
// 2️⃣ Initialize Sanity Client
// -----------------------------------------------------------------------------
const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  token: process.env.SANITY_WRITE_TOKEN,
  apiVersion: "2023-05-03",
  useCdn: false,
});

// -----------------------------------------------------------------------------
// 3️⃣ Rotation Logic (Your Existing Function)
// -----------------------------------------------------------------------------
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
    shuffledAndAndRanked = shuffledRemaining.filter(
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

// -----------------------------------------------------------------------------
// 4️⃣ Core Function: Reassign a single expired/declined assignment
// -----------------------------------------------------------------------------
async function reassignDeacon(assignmentDoc) {
  const assignment = assignmentDoc.data();

  console.log("\n🔄 Starting reassignment for:", assignment.sanityDocId);

  // ---------------------------------------------------------
  // STEP 1 — Load the original Sanity service document
  // ---------------------------------------------------------
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

  // ---------------------------------------------------------
  // STEP 2 — Load all deacons from Sanity
  // ---------------------------------------------------------
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

  // ---------------------------------------------------------
  // STEP 3 — Filter by REQUIRED reading language
  // ---------------------------------------------------------
  const requiredLang = (language?.language || "").trim().toUpperCase();

  const eligibleByLanguage = allDeacons.filter((d) =>
    (d.readinglanguage?.language || "").trim().toUpperCase() === requiredLang
  );

  if (eligibleByLanguage.length === 0) {
    console.log("❌ No deacons match required language:", requiredLang);
    return;
  }

  // ---------------------------------------------------------
  // STEP 4 — Load full service history for rotation
  // ---------------------------------------------------------
  const history = await sanityClient.fetch(`
    *[_type == "service"] | order(_createdAt asc){
      _createdAt,
      deaconName
    }
  `);

  // ---------------------------------------------------------
  // STEP 5 — Apply rotation + rank filtering
  // ---------------------------------------------------------
  const nextRotation = getFinalDeaconsArray(
    eligibleByLanguage,
    history,
    deaconRank?.rankName || "Any"
  );

  const nextDeacon = nextRotation[0];

  if (!nextDeacon) {
    console.log("❌ No eligible deacon found after rotation.");
    return;
  }

  console.log("👉 Replacement selected:", nextDeacon.deaconName);

  // ---------------------------------------------------------
  // STEP 6 — Create NEW Sanity service document (matching your schema)
  // ---------------------------------------------------------
  const newServiceDoc = await sanityClient.create({
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

  console.log("🆕 New Sanity replacement doc:", newServiceDoc._id);

  // ---------------------------------------------------------
  // STEP 7 — Create Firestore assignment for replacement
  // ---------------------------------------------------------
  const newAssignmentId = `${newServiceDoc._id}_${nextDeacon._id}`;

  await db.collection("ServiceAssignments").doc(newAssignmentId).set({
    sanityDocId: newServiceDoc._id,
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
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  console.log("📌 New FS assignment created:", newAssignmentId);

  // ---------------------------------------------------------
  // STEP 8 — Send push notification
  // ---------------------------------------------------------
  if (nextDeacon.expoPushToken) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: nextDeacon.expoPushToken,
        title: "New Service Assignment",
        body: `You have been assigned a replacement service.`,
        data: { sanityDocId: newServiceDoc._id },
      }),
    });

    console.log("📨 Push notification sent to:", nextDeacon.deaconName);
  }

  console.log("✅ Reassignment complete.");
}

// -----------------------------------------------------------------------------
// 5️⃣ MAIN EXECUTION (Runs Every 5 Minutes)
// -----------------------------------------------------------------------------
(async () => {
  console.log("⏳ Checking for expired assignments...");

  const now = Date.now();

  const snapshot = await db
    .collection("ServiceAssignments")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .get();

  if (snapshot.empty) {
    console.log("✨ No expired assignments found.");
    return;
  }

  console.log(`⚠ Found ${snapshot.size} expired assignments`);

  for (const doc of snapshot.docs) {
    const assignment = doc.data();

    // Mark Firestore as expired
    await doc.ref.update({
      status: "expired",
      respondedAt: now,
    });

    // Mark Sanity as expired
    await sanityClient.patch(assignment.sanityDocId)
      .set({ noResponse: true })
      .commit();

    // Perform reassignment
    await reassignDeacon(doc);
  }

  console.log("🏁 All reassignments processed.");
})();
