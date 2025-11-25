/**
 * FULL AUTOMATED REASSIGNMENT SCRIPT
 * Runs via GitHub Actions every 5 minutes
 */

const admin = require("firebase-admin");
const fetch = require("node-fetch");
const { createClient } = require("@sanity/client");

// -------------------------------------------
// 1️⃣ Initialize Firestore Admin SDK
// -------------------------------------------
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

// -------------------------------------------
// 2️⃣ Initialize Sanity Client
// -------------------------------------------
const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  token: process.env.SANITY_WRITE_TOKEN,
  apiVersion: "2023-05-03",
  useCdn: false,
});

// -------------------------------------------
// 3️⃣ Rotation Logic (YOUR OWN FUNCTION)
// Copy-Pasted from your app
// -------------------------------------------
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

// -------------------------------------------
// 4️⃣ Function: Reassign a single expired/declined assignment
// -------------------------------------------
async function reassignDeacon(assignmentDoc) {
  const data = assignmentDoc.data();

  const {
    sanityDocId, // original service doc
    serviceDate,
    serviceId,
    deaconId,
  } = data;

  console.log("\n🔄 Reassigning for:", sanityDocId);

  // ------------------------------------------
  // Load original Sanity document
  // ------------------------------------------
  const original = await sanityClient.fetch(
    `*[_type=="service" && _id==$id][0]{
      serviceDate,
      serviceDay,
      mainEvent,
      subEvent,
      prayer,
      reading,
      language,
      deaconRank->{_id, rankName}
    }`,
    { id: sanityDocId }
  );

  if (!original) {
    console.log("❌ Original Sanity document not found.");
    return;
  }

  const {
    reading,
    language,
    deaconRank,
    mainEvent,
    subEvent,
    prayer,
  } = original;

  // ------------------------------------------
  // Load ALL deacons
  // ------------------------------------------
  const allDeacons = await sanityClient.fetch(`
    *[_type == "deacon"]{
      _id,
      deaconName,
      email,
      phone,
      readinglanguage,
      deaconRank->{rankName},
      "rankId": deaconRank._ref
    }
  `);

  // ------------------------------------------
  // Load Service History
  // ------------------------------------------
  const history = await sanityClient.fetch(`
    *[_type == "service"] | order(_createdAt asc){
      _createdAt,
      deaconName
    }
  `);

  // ------------------------------------------
  // Choose next eligible deacon via rotation
  // ------------------------------------------
  const rotation = getFinalDeaconsArray(
    allDeacons,
    history,
    deaconRank?.rankName || "Any"
  );

  const nextDeacon = rotation[0];
  if (!nextDeacon) {
    console.log("❌ No eligible deacon found.");
    return;
  }

  console.log("👉 Replacement:", nextDeacon.deaconName);

  // ------------------------------------------
  // Create new Sanity document for replacement
  // ------------------------------------------
  const newSanityDoc = await sanityClient.create({
    _type: "service",
    serviceDate,
    serviceDay: new Date(serviceDate).toLocaleDateString("en-US", {
      weekday: "long",
    }),

    mainEvent,
    subEvent,
    prayer,

    reading: { _ref: reading._ref, _type: "reference" },
    language: { _ref: language._ref, _type: "reference" },

    deacon: { _ref: nextDeacon._id, _type: "reference" },
    deaconName: nextDeacon.deaconName,
    deaconRank: { _ref: nextDeacon.rankId, _type: "reference" },
    email: nextDeacon.email,
    phone: nextDeacon.phone,

    isAccepted: null,
    isRejected: null,
    noResponse: null,
    hasAttended: null,
  });

  console.log("🆕 New Sanity doc:", newSanityDoc._id);

  // ------------------------------------------
  // Create Firestore assignment
  // ------------------------------------------
  const assignmentId = `${newSanityDoc._id}_${nextDeacon._id}`;

  await db.collection("ServiceAssignments").doc(assignmentId).set({
    sanityDocId: newSanityDoc._id,
    serviceDate,
    serviceId,

    deaconId: nextDeacon._id,
    deaconName: nextDeacon.deaconName,
    email: nextDeacon.email,
    expoPushToken: nextDeacon.expoPushToken || null,

    readingRefId: reading._ref,
    languageRefId: language._ref,
    rankFilter: deaconRank.rankName,

    status: "pending",
    invitedAt: Date.now(),
    expiresAt: Date.now() + 48 * 60 * 60 * 1000,
  });

  console.log("📌 Firestore entry created:", assignmentId);

  // ------------------------------------------
  // Push Notification
  // ------------------------------------------
  if (nextDeacon.expoPushToken) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: nextDeacon.expoPushToken,
        title: "New Reassignment",
        body: `You have been reassigned a new service.`,
        data: { sanityDocId: newSanityDoc._id },
      }),
    });

    console.log("📨 Push sent to", nextDeacon.deaconName);
  }

  console.log("✅ Reassignment completed");
}

// -------------------------------------------
// 5️⃣ MAIN SCRIPT (run by GitHub Action)
// -------------------------------------------
(async () => {
  console.log("⏳ Checking for expired assignments...");

  const now = Date.now();

  const snapshot = await db
    .collection("ServiceAssignments")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .get();

  if (snapshot.empty) {
    console.log("✨ No expired assignments.");
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

    // Reassign automatically
    await reassignDeacon(doc);
  }

  console.log("🏁 Reassignment cycle complete.");
})();
