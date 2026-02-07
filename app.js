/* global supabase, APP_CONFIG */
const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const views = {
  auth: $("authView"),
  home: $("homeView"),
  register: $("registerView"),
  list: $("listView"),
  doctor: $("doctorView"),
  admin: $("adminView")
};
const tabs = $("tabs");
const logoutBtn = $("btnLogout");
const adminTab = $("adminTab");
const subtitle = $("subtitle");

let sessionUser = null;
let myRole = "staff";
let doctorsCache = [];

function show(el, yes){ el.hidden = !yes; }
function setMsg(id, text, ok=true){
  const el = $(id);
  el.hidden = false;
  el.style.borderColor = ok ? "#d1d5db" : "#ef4444";
  el.textContent = text;
}
function clearMsg(id){ const el=$(id); el.hidden=true; el.textContent=""; }

function routeTo(hash){
  const route = hash || "#home";
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  document.querySelector(`.tab[data-route="${route}"]`)?.classList.add("active");

  show(views.home, route==="#home");
  show(views.register, route==="#register");
  show(views.list, route==="#list");
  show(views.doctor, route==="#doctor");
  show(views.admin, route==="#admin");

  if(route==="#home") loadUpcoming();
  if(route==="#list") refreshEntireList();
  if(route==="#doctor") refreshDoctorView();
  if(route==="#admin") refreshAdminDoctors();
}

async function ensureProfile(user){
  const { data, error } = await sb
    .from("profiles")
    .select("role, display_name")
    .eq("id", user.id)
    .maybeSingle();

  if(error) console.warn(error);

  if(!data){
    await sb.from("profiles").insert({
      id: user.id,
      role: "staff",
      display_name: user.email
    });
    myRole = "staff";
  } else {
    myRole = data.role || "staff";
  }
  subtitle.textContent = `Logged in: ${user.email} • Role: ${myRole}`;
  show(adminTab, myRole === "admin");
}

async function loadDoctors(){
  const { data, error } = await sb.from("doctors").select("*").order("name");
  if(error){ console.error(error); return; }
  doctorsCache = data || [];
  fillDoctorSelects();
}

function fillDoctorSelects(){
  const selects = ["pDoctor","vDoctor","listDoctor","doctorSelect"];
  selects.forEach(id=>{
    const sel = $(id);
    sel.innerHTML = `<option value="">— None —</option>` + doctorsCache
      .filter(d=>d.active)
      .map(d=>`<option value="${d.id}">${escapeHtml(d.name)}</option>`)
      .join("");
  });
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* AUTH */
$("btnLogin").onclick = async () => {
  clearMsg("authMsg");
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error) return setMsg("authMsg", error.message, false);
  await onSignedIn(data.user);
};

$("btnSignup").onclick = async () => {
  clearMsg("authMsg");
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const { data, error } = await sb.auth.signUp({ email, password });
  if(error) return setMsg("authMsg", error.message, false);
  setMsg("authMsg", "Account created. If email confirmation is ON, please confirm via email, then login.", true);
  if(data.user) await onSignedIn(data.user);
};

logoutBtn.onclick = async () => {
  await sb.auth.signOut();
  sessionUser = null;
  myRole = "staff";
  showApp(false);
};

async function onSignedIn(user){
  sessionUser = user;
  await ensureProfile(user);
  await loadDoctors();
  showApp(true);
  location.hash = "#home";
  routeTo("#home");
}

function showApp(yes){
  show(views.auth, !yes);
  show(tabs, yes);
  show(logoutBtn, yes);
}

/* HOME: SEARCH FILE NO */
$("btnSearch").onclick = async () => {
  const fileNo = $("searchFileNo").value.trim();
  if(!fileNo) return;

  const { data: patient, error } = await sb
    .from("patients")
    .select("*, doctors(name)")
    .eq("clinic_file_no", fileNo)
    .maybeSingle();

  if(error) return alert(error.message);
  show($("searchResultPanel"), true);

  if(!patient){
    $("patientDetails").innerHTML = `<div class="item">No patient found for <b>${escapeHtml(fileNo)}</b></div>`;
    $("patientVisits").innerHTML = "";
    return;
  }

  $("patientDetails").innerHTML = `
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(patient.full_name)}</b><div class="small">${escapeHtml(patient.clinic_file_no)}</div>
          <div class="small">Phone: ${escapeHtml(patient.phone || "—")}</div>
          <div class="small">Assigned: ${escapeHtml(patient.doctors?.name || "—")}</div>
        </div>
        <span class="badge">Patient</span>
      </div>
      <div class="small">${escapeHtml(patient.notes || "")}</div>
    </div>
  `;

  const { data: visits, error: e2 } = await sb
    .from("visits")
    .select("*, doctors(name)")
    .eq("patient_id", patient.id)
    .order("visit_date", { ascending: false });

  if(e2) return alert(e2.message);

  $("patientVisits").innerHTML = (visits?.length ? visits : []).map(v => `
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(v.visit_date)}</b> ${v.visit_time ? `<span class="small">(${escapeHtml(v.visit_time)})</span>` : ""}
          <div class="small">Doctor: ${escapeHtml(v.doctors?.name || "—")} • Status: ${escapeHtml(v.status)}</div>
          <div class="small">Purpose: ${escapeHtml(v.purpose || "—")}</div>
        </div>
        <span class="badge">Visit</span>
      </div>
    </div>
  `).join("") || `<div class="item muted">No visits found.</div>`;
};

/* HOME: UPCOMING VISITS */
async function loadUpcoming(){
  const box = $("upcomingBox");
  box.innerHTML = `<div class="item muted">Loading…</div>`;

  const today = new Date();
  const start = today.toISOString().slice(0,10);
  const endDate = new Date(today.getTime() + 7*24*60*60*1000);
  const end = endDate.toISOString().slice(0,10);

  const { data, error } = await sb
    .from("visits")
    .select("visit_date, visit_time, status, purpose, patients(full_name, clinic_file_no), doctors(name)")
    .gte("visit_date", start)
    .lte("visit_date", end)
    .order("visit_date", { ascending: true })
    .order("visit_time", { ascending: true });

  if(error){ box.innerHTML = `<div class="item">${escapeHtml(error.message)}</div>`; return; }

  const rows = data || [];
  box.innerHTML = rows.length ? rows.map(v => `
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(v.visit_date)}</b> ${v.visit_time ? `<span class="small">(${escapeHtml(v.visit_time)})</span>` : ""}
          <div class="small">${escapeHtml(v.patients?.clinic_file_no || "")} • ${escapeHtml(v.patients?.full_name || "")}</div>
          <div class="small">Doctor: ${escapeHtml(v.doctors?.name || "—")} • ${escapeHtml(v.status)}</div>
          <div class="small">Purpose: ${escapeHtml(v.purpose || "—")}</div>
        </div>
        <span class="badge">Upcoming</span>
      </div>
    </div>
  `).join("") : `<div class="item muted">No upcoming visits (next 7 days).</div>`;
}

/* REGISTER PATIENT + VISIT */
$("btnSavePatientAndVisit").onclick = async () => {
  clearMsg("regMsg");

  const clinic_file_no = $("pFileNo").value.trim();
  const full_name = $("pName").value.trim();
  const phone = $("pPhone").value.trim() || null;
  const notes = $("pNotes").value.trim() || null;
  const assigned_doctor_id = $("pDoctor").value || null;

  const visit_date = $("vDate").value;
  const visit_time = $("vTime").value || null;
  const doctor_id = $("vDoctor").value || assigned_doctor_id || null;
  const purpose = $("vPurpose").value.trim() || null;

  if(!clinic_file_no || !full_name) return setMsg("regMsg", "Clinic File No and Full Name are required.", false);
  if(!visit_date) return setMsg("regMsg", "Visit date is required to schedule a future visit.", false);

  let patientId = null;

  const { data: existing, error: e1 } = await sb
    .from("patients")
    .select("id")
    .eq("clinic_file_no", clinic_file_no)
    .maybeSingle();

  if(e1) return setMsg("regMsg", e1.message, false);

  if(existing?.id){
    patientId = existing.id;
    const { error: eUp } = await sb
      .from("patients")
      .update({ full_name, phone, notes, assigned_doctor_id })
      .eq("id", patientId);

    if(eUp) return setMsg("regMsg", eUp.message, false);
  } else {
    const { data: inserted, error: eIns } = await sb
      .from("patients")
      .insert({ clinic_file_no, full_name, phone, notes, assigned_doctor_id })
      .select("id")
      .single();

    if(eIns) return setMsg("regMsg", eIns.message, false);
    patientId = inserted.id;
  }

  const { error: eV } = await sb
    .from("visits")
    .insert({
      patient_id: patientId,
      doctor_id,
      visit_date,
      visit_time,
      purpose,
      status: "scheduled",
      created_by: sessionUser.id
    });

  if(eV) return setMsg("regMsg", eV.message, false);

  setMsg("regMsg", "Saved successfully (patient + scheduled visit).", true);
  $("vPurpose").value = "";
  loadUpcoming();
};

/* ENTIRE LIST */
$("listDoctor").onchange = refreshEntireList;
$("listDate").onchange = refreshEntireList;
$("listSearch").oninput = debounce(refreshEntireList, 350);

async function refreshEntireList(){
  const box = $("listBox");
  box.innerHTML = `<div class="item muted">Loading…</div>`;

  const doctorId = $("listDoctor").value || null;
  const date = $("listDate").value || null;
  const q = ($("listSearch").value || "").trim().toLowerCase();

  let patientsQuery = sb.from("patients").select("*, doctors(name)").order("created_at", { ascending: false });
  if(doctorId) patientsQuery = patientsQuery.eq("assigned_doctor_id", doctorId);

  const { data: patients, error } = await patientsQuery;
  if(error){ box.innerHTML = `<div class="item">${escapeHtml(error.message)}</div>`; return; }

  let filtered = patients || [];

  if(q){
    filtered = filtered.filter(p =>
      (p.clinic_file_no || "").toLowerCase().includes(q) ||
      (p.full_name || "").toLowerCase().includes(q) ||
      (p.phone || "").toLowerCase().includes(q)
    );
  }

  if(date){
    const { data: visitRows, error: ev } = await sb
      .from("visits")
      .select("patient_id")
      .eq("visit_date", date);

    if(ev){ box.innerHTML = `<div class="item">${escapeHtml(ev.message)}</div>`; return; }

    const ids = new Set((visitRows||[]).map(v=>v.patient_id));
    filtered = filtered.filter(p => ids.has(p.id));
  }

  box.innerHTML = filtered.length ? filtered.map(p => `
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(p.full_name)}</b> <span class="small">(${escapeHtml(p.clinic_file_no)})</span>
          <div class="small">Assigned: ${escapeHtml(p.doctors?.name || "—")} • Phone: ${escapeHtml(p.phone || "—")}</div>
        </div>
        <span class="badge">Patient</span>
      </div>
      ${p.notes ? `<div class="small">${escapeHtml(p.notes)}</div>` : ""}
    </div>
  `).join("") : `<div class="item muted">No records found.</div>`;
}

/* DOCTOR PROFILE */
$("doctorSelect").onchange = refreshDoctorView;
$("doctorDate").onchange = refreshDoctorView;

async function refreshDoctorView(){
  const doctorId = $("doctorSelect").value || null;
  const date = $("doctorDate").value || new Date().toISOString().slice(0,10);
  $("doctorDate").value = date;

  const pBox = $("doctorPatients");
  if(!doctorId){
    pBox.innerHTML = `<div class="item muted">Select a doctor.</div>`;
    $("doctorVisits").innerHTML = `<div class="item muted">Select a doctor.</div>`;
    return;
  }

  pBox.innerHTML = `<div class="item muted">Loading…</div>`;
  const { data: pats, error: ep } = await sb
    .from("patients")
    .select("clinic_file_no, full_name, phone, created_at")
    .eq("assigned_doctor_id", doctorId)
    .order("created_at", { ascending: false });

  if(ep){ pBox.innerHTML = `<div class="item">${escapeHtml(ep.message)}</div>`; return; }

  pBox.innerHTML = (pats||[]).length ? (pats||[]).map(p=>`
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(p.full_name)}</b> <span class="small">(${escapeHtml(p.clinic_file_no)})</span>
          <div class="small">Phone: ${escapeHtml(p.phone || "—")}</div>
        </div>
        <span class="badge">Assigned</span>
      </div>
    </div>
  `).join("") : `<div class="item muted">No assigned patients.</div>`;

  const vBox = $("doctorVisits");
  vBox.innerHTML = `<div class="item muted">Loading…</div>`;

  const { data: vis, error: ev } = await sb
    .from("visits")
    .select("visit_time, status, purpose, patients(full_name, clinic_file_no)")
    .eq("doctor_id", doctorId)
    .eq("visit_date", date)
    .order("visit_time", { ascending: true });

  if(ev){ vBox.innerHTML = `<div class="item">${escapeHtml(ev.message)}</div>`; return; }

  vBox.innerHTML = (vis||[]).length ? (vis||[]).map(v=>`
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(v.visit_time || "—")}</b> <span class="small">${escapeHtml(v.status)}</span>
          <div class="small">${escapeHtml(v.patients?.clinic_file_no || "")} • ${escapeHtml(v.patients?.full_name || "")}</div>
          <div class="small">Purpose: ${escapeHtml(v.purpose || "—")}</div>
        </div>
        <span class="badge">Visit</span>
      </div>
    </div>
  `).join("") : `<div class="item muted">No visits for this date.</div>`;
}

/* ADMIN */
$("btnAddDoctor").onclick = async () => {
  clearMsg("adminMsg");
  const name = $("newDoctorName").value.trim();
  if(!name) return setMsg("adminMsg","Doctor name required.", false);

  const { error } = await sb.from("doctors").insert({ name, active:true });
  if(error) return setMsg("adminMsg", error.message, false);

  $("newDoctorName").value = "";
  setMsg("adminMsg","Doctor added.", true);
  await loadDoctors();
  refreshAdminDoctors();
};

async function refreshAdminDoctors(){
  if(myRole !== "admin") return;
  const box = $("doctorListAdmin");
  box.innerHTML = `<div class="item muted">Loading…</div>`;

  const { data, error } = await sb.from("doctors").select("*").order("name");
  if(error){ box.innerHTML = `<div class="item">${escapeHtml(error.message)}</div>`; return; }

  box.innerHTML = (data||[]).map(d=>`
    <div class="item">
      <div class="top">
        <div>
          <b>${escapeHtml(d.name)}</b>
          <div class="small">Active: ${d.active ? "Yes" : "No"}</div>
        </div>
        <span class="badge">Doctor</span>
      </div>
    </div>
  `).join("") || `<div class="item muted">No doctors yet.</div>`;
}

/* NAV */
document.querySelectorAll(".tab").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    location.hash = btn.dataset.route;
  });
});

window.addEventListener("hashchange", ()=> routeTo(location.hash));

function debounce(fn, wait){
  let t=null;
  return (...args)=>{
    clearTimeout(t);
    t=setTimeout(()=>fn(...args), wait);
  };
}

/* INIT */
(async function init(){
  const { data } = await sb.auth.getSession();
  if(data.session?.user){
    await onSignedIn(data.session.user);
  } else {
    showApp(false);
  }

  const today = new Date().toISOString().slice(0,10);
  $("doctorDate").value = today;

  sb.auth.onAuthStateChange(async (_event, sess) => {
    if(sess?.user){
      await onSignedIn(sess.user);
    } else {
      showApp(false);
    }
  });
})();
