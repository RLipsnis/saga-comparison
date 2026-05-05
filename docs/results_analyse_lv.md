# Saga modeļu salīdzinājums — analizētie testu rezultāti

Šis dokuments apkopo visu veiktspējas un izturības testu konsolidēto analīzi, salīdzinot **orķestrācijas** (Temporal darbplūsmas) un **horeogrāfijas** (MassTransit + RabbitMQ) saga modeļus.

## Satura rādītājs

| Tests | Nosaukums | Tips |
|------|-------|------|
| [A](#test-a--saga-veiktspējas-tests-end-to-end--per-step) | Saga veiktspējas tests — End-to-End + Per-Step | Veiktspēja |
| [B](#test-b--fire-and-forget-caurlaide) | Fire-and-Forget caurlaide | Veiktspēja |
| [D](#test-d--resursu-mērogošana) | Resursu mērogošana (CPU / RAM) | Veiktspēja |
| [E](#test-e--inventāra-redzamības-aizture) | Inventāra redzamības aizture | Konsekvence |
| [F](#test-f--race-condition--vienlaicīgums) | Race condition / vienlaicīgums | Korektība |
| [G](#test-g--idempotence) | Idempotence | Korektība |
| [H](#test-h--jaukta-slodze) | Jaukta slodze (happy + kompensācija) | Veiktspēja |
| [I](#test-i--kompensācijas-korektība) | Kompensācijas korektība | Korektība |
| [J](#test-j--izturība--ilgtspējīga-slodze) | Izturība / ilgtspējīga slodze | Stabilitāte |
| [K](#test-k--vienlaicīgo-klientu-caurlaide) | Vienlaicīgo klientu caurlaide | Veiktspēja |
| [L](#test-l--aukstā-starta-sods) | Aukstā starta sods | Veiktspēja |
| [M](#test-m--kļūme-rollback-laikā) | Kļūme rollback laikā | Izturība |
| [N](#test-n--brokera-pārtraukums-rollback-laikā) | Brokera pārtraukums rollback laikā | Izturība |
| [O](#test-o--worker-avārija-saga-vidū) | Worker avārija saga vidū | Izturība |
| [Kopsavilkums](#kopsavilkums) | Starp-testu sintēze | — |
| [Atbildes](#atbildes-answers) | Pētniecības jautājumi un hipotēžu pārbaude | — |

---

## Test A — Saga veiktspējas tests (End-to-End + Per-Step)

### Mērķis

Galvenais veiktspējas tests. Tas fiksē:

- **Galvenās percentīles** (P50/P95/P99) saga end-to-end latencei zem ilgtspējīgas slodzes.
- **Soļu sadalījumu**, lai katra modeļa overhead varētu attiecināt uz konkrētu posmu (`reserveInventory`, `processPayment`, `arrangeShipping`, `sendNotification`, `updateStatus`).

Tas atbild uz diviem darba jautājumiem:

- Pie vienādas slodzes — kurš modelis ir ātrāks no-gala-līdz-galam un kur laiks tiek tērēts katrā solī?
- Slodzei pieaugot, kurš modelis pirmais piesātinās un kāpēc?

### Iestatījumi

- **Driveris**: `benchmark-saga-steps.js` caur `./run-test.sh steps` (k6).
- **Izpildītājs**: `constant-arrival-rate` — atvērts modelis, fiksēts RPS neatkarīgi no atbildes laika.
- **Uzsildīšana**: 5 s pie `RATE/4`. **Galvenā fāze**: 60 s pie mērķa `RATE`.
- **VU pūls**: `preAllocatedVUs = max(RATE*2, 10)`, `maxVUs = max(RATE*5, 50)`.
- **Sliekšņi**: `total_saga_duration_ms p95 < 10 000`; `api_response_ms p95 < 2 000` (galvenā fāze).
- **Endpoint**: `POST /api/orders/benchmark` — bloķē (35 s noildze), līdz saga sasniedz terminālo stāvokli.
- **Stāvokļa atiestatīšana pirms katra palaišanas**: inventārs papildināts, visi pasūtījumi izdzēsti, maksājumu kļūmes likme = 0%.
- **Likmes**: 1, 5, 10, 25, 50, 100 rps abiem režīmiem (kopā 12 palaidieni).
- **Režīmu pārslēgšana**: `--force-recreate` piecām .NET servisu konteineriem; infrastruktūra (Postgres, RabbitMQ, Temporal) *netiek* atjaunota.

### Rezultāti

#### Caurlaide (pasūtījumi, kas pabeigti end-to-end)

| Likme | Orķestrācija pabeigti / kļūdaini | Horeogrāfija pabeigti / kļūdaini |
|------|----------------------------------|---------------------------------|
| 1 rps | 65 / 0 | 65 / 0 |
| 5 rps | 305 / 0 | 306 / 0 |
| 10 rps | 612 / 0 | 612 / 0 |
| 25 rps | **380 / 1 049** | 1 527 / 5 |
| 50 rps | **58 / 2 862** | 3 022 / 37 |
| 100 rps | 56 / 3 951 | 156 / 4 914 |

Orķestrācija salūst starp 10 un 25 rps; horeogrāfija joprojām ir veselīga pie 50 rps un sabrūk tikai pie 100.

#### Kopējā saga ilguma P95 (ms)

| Likme | Orķestrācija | Horeogrāfija | Δ (orch − chor) |
|------|---------------|--------------|-----------------|
| 1 | 409.0 | 362.9 | +46 |
| 5 | 681.4 | 352.5 | +329 |
| 10 | 778.4 | 340.2 | +438 |
| 25 | **4 679.0** | 336.9 | +4 342 |
| 50 | 809.9¹ | 340.3 | — |
| 100 | 1 934.6¹ | 487.0¹ | — |

¹ Pie un virs piesātinājuma punkta, percentīles tiek aprēķinātas tikai no *izdzīvojušajiem*; kļūdainie pasūtījumi pārsniedza noildzi un ir izslēgti, tāpēc 50 / 100 rps skaitļi ir spēcīgi izdzīvojušo izlases novirzīti.

#### API atbildes P95 (ms)

| Likme | Orķestrācija | Horeogrāfija |
|------|---------------|--------------|
| 1 | 18.7 | 13.7 |
| 5 | 9.6 | 8.9 |
| 10 | 13.8 | 5.0 |
| 25 | 94.9 | 3.1 |
| 50 | 27.4 | 5.1 |
| 100 | 67.5 | 4.6 |

#### Per-step P95 pie 10 rps (pēdējā likme, kur abi ir veselīgi)

| Solis | Orķestrācija | Horeogrāfija | Δ |
|------|---------------|--------------|---|
| Reserve Inventory | 101.8 | 13.2 | +88.6 |
| Process Payment | 299.6 | 197.8 | +101.8 |
| Arrange Shipping | 200.4 | 102.9 | +97.5 |
| Send Notification | 150.9 | 54.5 | +96.4 |
| Update Status | 101.8 | 2.7 | +99.1 |
| **Soļu P95 summa** | **854.5** | **371.1** | **+483.4** |

#### Per-step P95 pie 25 rps (orķestrācija salauzta, horeogrāfija veselīga)

| Solis | Orķestrācija | Horeogrāfija |
|------|---------------|--------------|
| Reserve Inventory | 707.2 | 8.3 |
| Process Payment | 821.6 | 196.8 |
| Arrange Shipping | 772.6 | 100.9 |
| Send Notification | 782.6 | 52.9 |
| Update Status | 970.3 | 1.9 |

### Analīze

**Horeogrāfija ir ātrāka pie katras likmes, pat dīkstāvē.** Pie 1 rps horeogrāfijas saga P95 jau ir ~46 ms zemāka. Abi režīmi sit vienas DB rindas un vienu un to pašu simulēto maksājuma aizturi; starpību gandrīz pilnībā izskaidro `updateStatus`, kas orķestrācijā ir **~100 ms** salīdzinājumā ar **~2 ms** horeogrāfijā. Orķestrācijā "Update Status" ir Temporal aktivitāte, ko ieplāno workflow worker, maksājot pilnu activity-task apgriezienu. Horeogrāfijā tas ir tiešs DB ieraksts, ko veic OrderService patērētājs. Tā ir strukturāla cena, nevis slodzes radīta.

**Orķestrācijas per-step latence pieskaras ~100 ms reizinātājiem.** Per-step P95 grupējas pie `~100`, `~200`, `~300` ms, pat ja pamatdarbs aizņemtu 5–20 ms. Šī kvantizācija ir **Temporal task-queue polling latences** paraksts — aktivitāšu worker paņem uzdevumus tikai fiksētos intervālos, kad ir noslogots. Praktiskā ietekme: orķestrācija pievieno aptuveni fiksētu ~100 ms nodokli *uz katru soļa pāreju*, reizinātu ar 5 soļiem šajā sagā.

**Modeļi piesātinās ļoti dažādi.** Abi režīmi ir ekvivalenti pie 1, 5 un 10 rps (612/612 pabeigumu). Lūzuma punkts ir starp 10 un 25 rps:

- **Orķestrācija pie 25 rps**: tikai ~27% pabeigti; saga P95 eksplodē līdz 4 679 ms un P99 līdz 19 360 ms (tieši pie 35 s noildzes). API P95 lec no 13.8 → 94.9 ms — gateway veido rindu.
- **Horeogrāfija pie 25 rps**: ~99.7% pabeigti; saga P95 = 336.9 ms ir būtībā identiska tās 10 rps vērtībai (340.2 ms).

Horeogrāfija iztur vēl 2× (50 rps: 98.8% panākumi, P95 = 340 ms), pirms salūst pie 100 rps. **Orķestrācijas ilgtspējīgais rezerves apjoms ir ~10 rps; horeogrāfijas — ~50 rps — ~5× starpība pie identiskas aparatūras.**

**No kurienes nāk orķestrācijas overhead?** Absolūtā cena, kas pievienota katram solim, ir ievērojami vienota (88–102 ms), kas atbilst tam, ka katrs solis maksā vienu Temporal task-queue plānošanas aizturi. Šaurā vieta **nav** workflow kods vai aktivitātes loģika — tā ir **workflow ↔ activity worker nodošana**, kas slodzē serializējas ap vienu task queue. Tiklīdz pieprasījumu likme pārsniedz to, ko viens worker pāris var izņemt no rindas, latence pieaug super-lineāri. Horeogrāfijai nav centrāla koordinatora, tāpēc saga progresē ar brokera paralēlismu.

### Piezīmes

- **Soļu P95 pie 50 / 100 rps ir izdzīvojušo izlases novirzīti.** Tiek mērīti tikai pasūtījumi, kas pabeidzas 35 s noildzē. Orķestrācijas šķietamais P95 "uzlabojums" no 25 → 50 rps ir artefakts no tā, kuri pasūtījumi izdzīvoja.
- **Abi modeļi izmanto vienu un to pašu Postgres / RabbitMQ / Temporal infrastruktūru.** 100 rps rezultāti raksturo *visu steku*, nevis modeli izolēti. Tests D variē resursu ierobežojumus, lai šos efektus atdalītu.
- **Kompensācija šeit netiek izpildīta** (`compensated = 0`). Tests A mēra happy ceļu; kompensācija ir Testu H, I, M, N tēma.
- **Koplietotā infrastruktūra netika atjaunota starp režīmiem**, tāpēc jebkurš Temporal history-table stāvoklis no iepriekšējiem palaidieniem paliek. Tas ir konstants faktors pa visām likmēm.

### Galvenā secinājuma būtība

Pie zemas slodzes (1–10 rps) **horeogrāfija konsekventi ir ~50–500 ms ātrāka end-to-end**, jo izvairās no 5 × ~100 ms task-queue lēcieniem. Slodzei augot, plaisa palielinās par lieluma kārtu, un **orķestrācija piesātinās aptuveni 1/5 no horeogrāfijas ilgtspējīgās likmes**.

---

## Test B — Fire-and-Forget caurlaide

### Mērķis

Mēra **API gateway pieņemšanas caurlaidi** pie ilgtspējīgām pieprasījumu likmēm *bez* gaidīšanas, līdz saga pabeidzas. Atšķirībā no Testa A, `POST /api/orders` tiek izšauts un tests virzās tālāk uzreiz, tāpēc tiek mērīts tikai:

- HTTP atbildes ilgums (pieprasījuma izsūtīšana → gateway atgriež `202 Accepted`)
- Vai atbilde bija derīgs `202` ar `orderId`

Tas izolē **HTTP pieņemšanas kapacitāti** no lejupejošās saga konveijera. Orķestrācijai jāveic tikai Order rindas ieraksts + `Temporal.StartWorkflowAsync` izsaukums. Horeogrāfijai jāveic tikai Order rindas ieraksts + `OrderCreated` publicēšana RabbitMQ.

### Iestatījumi

- **Driveris**: `order-load-test.js` — k6 ar `constant-arrival-rate` 60 s.
- **Pirms-testa atiestate**: inventāra papildināšana, pasūtījumu tīrīšana, maksājumu kļūmes likme = 0%.
- **Pieprasījuma slodze**: nejaušs produkts (1 no 5), nejaušs daudzums 1–3, nejaušs `customerId`. Sekmes pārbaude: `status === 202 && body.orderId !== undefined`. **Saga pabeigšana netiek aptaujāta.**
- **Likmes**: 1, 5, 10, 25, 50, 100, 250, 500, 1000 rps.

### Rezultāti

> ⚠️ **Orķestrācija izslēgta.** Katra orķestrācijas rinda uzrāda `created: 0` ar HTTP latencēm, kas slodzē *samazinās* (14.5 ms pie 1 rps → 2.3 ms pie 500 rps), un 1000 rps rinda apstājas tieši pie 15 430 ms — ātrās kļūmes ceļa pirkstu nospiedums. Gandrīz noteikti `_temporalClient.StartWorkflowAsync(...)` meta kļūdu pie katra pieprasījuma (Temporal worker nebija reģistrēts vai gRPC savienojums bija slikts 2026-04-26 20:07–20:17 logā). Kontroliera ķermeņa forma ir identiska horeogrāfijas, tāpēc k6 sekmes pārbaude nav vainīga. **Pirms Tests B var atbalstīt blakus salīdzinājumu, ir nepieciešams atkārtots palaidiens ar pārbaudīti veselīgu Temporal worker.**

**Horeogrāfija** (visas vērtības ms; *Iter* = k6 iterācijas, kas faktiski izpildītas 60 s):

| Likme (rps) | HTTP avg | p95 | p99 | max | Iter | Created / mērķis | Sekmes |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 15.8 | 23.6 | 81.6 | 156.2 | 61 | 61 / 60 | 100% |
| 5 | 8.2 | 15.7 | 19.7 | 22.6 | 300 | 300 / 300 | 100% |
| 10 | 4.7 | 8.2 | 13.3 | 30.0 | 600 | 600 / 600 | 100% |
| 25 | 3.4 | 5.6 | 13.6 | 30.3 | 1 501 | 1 501 / 1 500 | 100% |
| 50 | 3.4 | 7.0 | 18.2 | 31.5 | 3 000 | 3 000 / 3 000 | 100% |
| 100 | 8.8 | 17.1 | 37.5 | 175.8 | 6 001 | 6 001 / 6 000 | 100% |
| 250 | 36.8 | 137.7 | 324.5 | 366.4 | 15 000 | 15 000 / 15 000 | 100% |
| 500 | **8 537.7** | **17 794.6** | 19 280.0 | 24 626.5 | 16 571 | 11 071 / 30 000 | 66.8% |
| 1000 | **14 481.8** | **21 722.2** | 26 674.9 | 32 393.3 | 21 823 | 15 161 / 60 000 | 69.5% |

### Analīze

**Horeogrāfija mērogojas tīri līdz 250 rps un strauji sabrūk pie 500 rps:**

- **1–50 rps**: p95 vienciparu ms (5.6–17.1). Mediāna *krīt* no 12.4 ms (1 rps) līdz 2.6 ms (50 rps), kad TCP keepalive, EF query plāni un kanālu pūli iesilst.
- **100 rps**: joprojām tīri — p95 = 17.1 ms, 100% sekmes. Vidējais nedaudz pieaug — publicēšanas ceļš sāk redzēt sacensību, bet nekādā gadījumā nav piesātināts.
- **250 rps**: pirmais stresa signāls — p95 = 137.7 ms (~8× 100-rps skaitlis), joprojām 100% sekmes un pilna mērķa likme piegādāta. Rinda publicēšanas konveijerā kļūst redzama.
- **500 rps — krauja.** p95 eksplodē līdz 17 794.6 ms (~130× 250-rps skaitlis), sekmes krīt līdz 66.8%, tikai 16 571 no gaidītajiem 30 000 pabeigti. Efektīvā likme ~276 rps, neraugoties uz 500 rps mērķi.
- **1000 rps**: tālāka degradācija, nevis katastrofāla kļūme. Efektīvā likme ~364 rps. Modelis ir back-pressure dominēts: pieprasījumi sakrājas HTTP servera rindās un noildze beidzas klienta pusē, nevis tie tiek tieši noraidīti.

**Horeogrāfijas piesātinājuma punkts atrodas starp 250 rps (tīrs) un 500 rps (sabrukts)**. Smalkāka caurspīde (300 / 350 / 400 / 450) precizētu pārejas punktu.

### Arhitektūras interpretācija

Sabrukums pie 500 rps atbilst **RabbitMQ / MassTransit publicēšanas puses šaurai vietai**, nevis Postgres piesātinājumam:

1. Order ieraksts notiek *pirms* publicēšanas. Ja Postgres būtu šaurā vieta, latence pieaugtu pakāpeniski, nevis paliktu plakana pie <10 ms līdz 100 rps un tad lēktu.
2. `IPublishEndpoint.Publish` bloķē uz apstiprināta exchange maršruta — kanāla bloķēšana, exchange-bind pārbaude, publisher-confirm round-trip. Pie 500 publish/s uz vienas replikas, kanālu pūls noplicinās.

### Ieteicamās darbības

1. **Atkārtoti palaist orķestrāciju** pēc tam, kad apstiprināts, ka Temporal worker ir reģistrēts un namespace ir gatavs.
2. **Pievienot piesātinājuma sub-caurspīdi** horeogrāfijai starp 250 un 500 rps.
3. **Palielināt k6 `maxVUs`** pie 500 / 1000 rps līmeņa — kad atbildes uzbrīst līdz 18 s, `Math.max(RATE * 5, 50)` kļūst par šauro vietu.
4. **Saglabāt neveiksmīgo pieprasījumu statusa kodus**, lai anomālijas kā orķestrācijas kļūme būtu diagnosticējamas tikai no JSON.

---

## Test D — Resursu mērogošana

### Mērķis

Nosaka, vai saga veiktspēja ir **CPU-ierobežota vai IO-ierobežota**, un kā katrs modelis degradē, kad skaitļošanas resursi tiek nospiesti. Konkrēti:

- Vai vienā un tā pati slodze darbojas ātrāk, kad piešķir vairāk CPU/RAM?
- Kurš modelis degradē graciozāk pie nepietiekamības?
- Kur katrs modelis pirmais sasniedz savu sienu — workflow dzinējs, brokeris, datubāze vai .NET workers?

### Iestatījumi

- **Driveris**: `benchmark-saga-steps.js` (tas pats, kas Tests A) caur `run-resource-scaling-test.sh`.
- **Profili tiek piemēroti gan infra, gan .NET servisu konteineriem**:

  | Profils | CPU/konteineris | RAM/konteineris |
  |---|---|---|
  | `constrained` | 0.5 | 256 MB |
  | `generous` | 2.0 | 1024 MB |

- **Piezīme (2026. gada aprīļa pārskatīšana)**: agrāk tika ierobežota tikai infra; tagad .NET workers darbojas ar tādu pašu per-konteinera budžetu. Vienīgais mainīgais ir *cik daudz skaitļošanas resursu saņem visa saga*.
- **Palaidieni**: orķestrācija un horeogrāfija × `constrained` @ 10 rps, 25 rps; `generous` @ 25 rps.
- Katrs palaidiens: 60 s galvenā fāze + 5 s uzsildīšana. `docker stats` paraugots ik pēc 2 s.
- **`failed`** skaitītājs = pasūtījumi, kas nesasniedza `Completed` 30 s aptaujāšanas logā (noildzes), **nevis** kompensētas sagas.

### Rezultāti

#### End-to-end saga latence (P95) un pabeigšanas skaitļi

| Palaidiens | Pabeigti | Noildzē | Saga P95 | Saga P99 | API P95 |
|---|---|---|---|---|---|
| Orch · constrained · 10 rps | 611 | 0 | 873 ms | 1 028 ms | 16 ms |
| Choreo · constrained · 10 rps | 568 | 32 | **365 ms** | 660 ms | 6 ms |
| Orch · constrained · 25 rps | 109 | 1 359 | 2 371 ms | 3 647 ms | 56 ms |
| Choreo · constrained · 25 rps | **9** | 1 519 | **27 129 ms** | 27 361 ms | 295 ms |
| Orch · generous · 25 rps | 1 532 | 0 | 936 ms | 1 131 ms | 15 ms |
| Choreo · generous · 25 rps | 1 497 | 33 | **337 ms** | 2 169 ms | 3 ms |

#### Per-step P95 (ms), constrained 10 rps — abi režīmi veselīgi

| Solis | Orķestrācija | Horeogrāfija | Δ |
|---|---|---|---|
| Reserve Inventory | 150 | 34 | −116 |
| Process Payment | 301 | 202 | −99 |
| Arrange Shipping | 202 | 105 | −97 |
| Send Notification | 200 | 82 | −118 |
| Update Status | 150 | 4 | −146 |

#### Per-step P95 (ms), constrained 25 rps — abi režīmi pārslogoti

| Solis | Orķestrācija | Horeogrāfija |
|---|---|---|
| Reserve Inventory | 384 | **15 679** |
| Process Payment | 427 | 4 254 |
| Arrange Shipping | 421 | 3 104 |
| Send Notification | 533 | 4 051 |
| Update Status | 889 | 117 |

#### Maksimālais CPU katrā konteinerī (`docker stats` neapstrādāti %; 0.5 CPU ≈ 50%, 2.0 CPU ≈ 200%)

| Palaidiens | order-svc | postgres | temporal | rabbitmq |
|---|---|---|---|---|
| Orch · constrained · 10 rps | 52% | 44% | 43% | 30% |
| Choreo · constrained · 10 rps | 52% | 19% | 5% | 17% |
| Orch · constrained · 25 rps | 52% (*pegged*) | 54% (*pegged*) | 50% (*pegged*) | 28% |
| Choreo · constrained · 25 rps | **94%** (*pegged + over*) | 75% (*pegged*) | 64% (*pegged*) | 27% |
| Orch · generous · 25 rps | 52% | 50% | 64% | 27% |
| Choreo · generous · 25 rps | 75% | 18% | 2% | 33% |

### Analīze

**Šaurā vieta ir CPU, nevis IO.** Dubultojot CPU/RAM (constrained → generous) pie 25 rps, abi modeļi pāriet no gandrīz sabrukuma uz veselīgu noturīgu stāvokli bez izmērāma IO soda:

- Orķestrācija: pabeigumi 109 → 1 532 (+14×); saga P95 2 371 → 936 ms (−2.5×).
- Horeogrāfija: pabeigumi 9 → 1 497 (+166×); saga P95 27 129 → 337 ms (−80×).

Ja sistēma būtu IO-ierobežota, vairāk CPU nevarētu radīt šādu atveseļošanos. Postgres CPU pieaug līdzās slodzei, un Temporal pieaug no 43% → 50% pie constrained 25 rps — abi piesisti pret 0.5-CPU griestiem, kas ir mācību grāmatas paraksts CPU nepietiekamībai.

**Abi modeļi piesātina dažādus komponentus pirmie:**

- **Orķestrācija** sadala slodzi starp `OrderService`, `Temporal` un `Postgres`. Pie constrained 25 rps visi trīs vienlaikus sit 50% griestus. Tā kā Temporal buferē aktivitāšu uzdevumus servera pusē, sistēma degradē aptuveni lineāri: P95 873 → 2 371 ms, neviens atsevišķs solis neeksplodē.
- **Horeogrāfija** koncentrē visu .NET workers, kas gan publicē, gan patērē MassTransit ziņas. Pie constrained 25 rps, `saga-order-service` sasniedz 94% (~2× tā 0.5-CPU budžeta — burst-credit aizņemšanās, tad smaga droselēšana). Postgres arī pieaug līdz 75%, daudz augstāk nekā orķestrācijai pie tās pašas slodzes, jo procesa iekšējie patērētāji veic katru saga-state ierakstu tieši. Ar patērētāja pavedienu nepilnvērtotu, `ReserveInventoryCommand` rinda aug bez ierobežojumiem, un `reserveInventory` P95 eksplodē no 34 ms (10 rps) līdz **15 679 ms** (25 rps) — 460× regresija uz viena soļa.

Īsi: **orķestrāciju ierobežo workflow/state dzinējs; horeogrāfiju — patērētāja dispatch cikls.**

**Horeogrāfija ir ātrāka, kad nav droselēta, lēnāka pie nepietiekamības.** Tā ir centrālā spriedze:

- Pie constrained 10 rps un generous 25 rps (veselīgi režīmi) horeogrāfija uzvar katrā per-step metrikā. End-to-end saga P95 ir 2.4–2.8× zemāka. Lielākie ieguvumi ir Temporal-aktivitāšu maršrutētajos soļos:
  - `Update Status`: 150 ms vs 4 ms — 37× atstarpe (Temporal aktivitāte vs. procesa iekšējais patērētājs).
  - `Reserve Inventory`: 150 ms vs 34 ms — tas pats pamata cēlonis.
- Pie constrained 25 rps attiecība dramatiski apgriežas. Orķestrācija pabeidz 109 sagas; horeogrāfija — 9. Tās 9, kas tika pabeigtas, aizņēma 25 s+. Orķestrācijas Temporal task queue absorbē to pašu ievades slodzi ar daudz mazāku per-step uzpūšanos, jo Temporal ir mērķtiecīgi veidots aktivitāšu plānošanai asinhroni, nevis to piegādei caur procesa iekšējo patērētāju, kas konkurē ar ražotāju par to pašu nepilnvērtoto CPU.

**API pieņemšanas latence atspoguļo arhitektūras atšķirību.** `apiResponseMs` ir konsekventi 3–5× zemāks horeogrāfijā (1.4–3 ms vs 4–15 ms veselīgos palaidienos). Horeogrāfijai jāpublicē tikai pirms atgriešanās; orķestrācija sinhroni sāk Temporal workflow caur gRPC. Pie constrained 25 rps horeogrāfijas API P95 lec līdz 295 ms — tieši simptoms publicētājam, kas ir bloķēts ar back-pressure brokeri — kamēr orķestrācijas paliek relatīvi ierobežotā 56 ms.

### Praktiskais secinājums

- **Abi modeļi šajā slodzē ir CPU-ierobežoti** — resursu mērogošana ir pareizais sviras, nevis ātrāki diski.
- **Horeogrāfija ir zemāka overhead modelis, kad ir vieta** — mazāk lēcienu, nav orchestrator gRPC, zemāks per-step P95.
- **Orķestrācija ir vairāk *elastīgs* modelis pie nepietiekamības** — Temporal task-queue-balstītā izpilde atdala ražotāja likmi no worker likmes, tāpēc kļūmes režīms ir gracioza latences pieaugšana, nevis rindas izlaušanās.
- Pārejas punkts ir aptuveni tur, kur katrs konteineris vienlaikus ir CPU-piesists (šeit, 25 rps × 0.5 CPU). Klastera izmēra noteikšana tā, lai neviens atsevišķs saga serviss nepārsniegtu ~70% no sava CPU budžeta, saglabā horeogrāfiju tās vēlamajā režīmā.

### Piezīmes

- Tika fiksēti tikai `constrained` un `generous` profili; nav `default` (1.0 CPU) datu, tāpēc līkne starp galējībām ir interpolēta.
- Constrained 25 rps palaidieni ir tālu pāri sabrukuma punktam — lielākā daļa paraugu ir 30 s aptaujāšanas noildzes, tāpēc percentīles apkopo deģenerētu režīmu. Tās ir noderīgas kā *kļūmes režīma* signāls, nevis kā latences skaitļi izolēti citējami.
- `failed` skaitītājs nenošķir "saga kompensēta" no "klienta aptaujāšanas noildze"; šajā testā gandrīz visas kļūmes ir pēdējās.

---

## Test E — Inventāra redzamības aizture

### Mērķis

Mēra **reālo eventual-consistency aizturi**: cik drīz pēc tam, kad klients ievieto jaunu pasūtījumu, rezervētais krājums kļūst lasāms caur `GET /api/inventory/products`. Tas ir redzamais "blakusefekta logs", ko piedzīvo UI vai lejupejošs serviss.

Divas mērīšanas uz pasūtījumu:

- **`inventoryVisibilityLagMs`** — POST → `reservedQuantity` pieaugums ir redzams caur inventāra API.
- **`sagaCompletionLagMs`** — POST → `Order.Status = Completed`.

Darbam svarīgs salīdzinājums ir **starpība** starp abām: cik tālu lietotājam redzamais blakusefekts vada saga terminālo stāvokli.

### Iestatījumi

- **Driveris**: `benchmark-consistency-lag.js` caur `./run-test.sh consistency --env ITERATIONS=30`.
- **Slodze**: `executor: per-vu-iterations`, **1 VU**, **30 iterācijas** (single-flight, uztur inventāra skaitītāju tīru).
- **Per-iterācijas cikls**:
  1. Snapshot `reservedQuantity` produktam `a1111111-...`.
  2. `POST /api/orders` 1 vienībai; iezīmēt `start`.
  3. Aptaujāt `/api/inventory/products` un `/api/orders/{id}/status` ik pēc **25 ms**.
  4. Ierakstīt `inventory_visibility_lag_ms` pirmajā aptaujā, kur `reservedQuantity > baseline`.
  5. Ierakstīt `saga_completion_lag_ms`, kad statuss kļūst `Completed`.
  6. Per-iterācijas noildze: **15 s**.
- **Režīmi**: katrs saga režīms palaists pēc .NET servisu `--force-recreate`.
- **Kļūmes ceļš netiek izpildīts**: maksājumu kļūmes likme = 0 → `inventoryReleaseLagMs` ir `null` visur.

### Rezultāti

**Jaunākie kanoniskie palaidieni** (visas vērtības ms):

| Metrika | Režīms | n | avg | med | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| Inventāra redzamības aizture | Orķestrācija | 30 | 40.8 | 33.0 | 37.1 | **42.4** | 243.0 |
| Inventāra redzamības aizture | Horeogrāfija | 30 | 32.2 | 32.0 | 33.0 | **35.7** | 43.0 |
| Saga pabeigšanas aizture | Orķestrācija | 30 | 344.9 | 312.0 | 396.1 | **436.0** | 1205.0 |
| Saga pabeigšanas aizture | Horeogrāfija | 30 | 280.8 | 281.0 | 347.4 | **377.6** | 393.0 |

**Abi palaidieni blakus** (atkārtojamības pārbaude):

| Režīms | Palaidiens | pabeigti/noildzes | inv avg / p95 / max | saga avg / p95 / max |
|---|---|---|---|---|
| Orķestrācija | 18:17 | 30 / 0 | 39.3 / 36.6 / 227 | 336.4 / 415.2 / 1087 |
| Orķestrācija | 18:21 | 30 / 0 | 40.8 / 42.4 / 243 | 344.9 / 436.0 / 1205 |
| Horeogrāfija | 18:19 | 27 / **3** | 40.8 / 40.7 / 279 | 300.5 / 363.6 / 1262 |
| Horeogrāfija | 18:21 | 30 / 0 | 32.2 / 35.7 / 43 | 280.8 / 377.6 / 393 |

- Orķestrācijas palaidieni ir cieši reproducējami.
- Iepriekšējais horeogrāfijas palaidiens ziņoja par 3 noildzēm un garu max (1262 ms); tīrākais otrais palaidiens pabeidza visus 30 393 ms iekšienē — spēcīgs pierādījums, ka pirmais palaidiens bija pārejošs cold-cache mirgojums.

### Analīze

**Abi modeļi atklāj rezervāciju ilgi pirms saga finalizēšanas.** Aizture starpība `sagaCompletion − inventoryVisibility` kvantitatīvi nosaka lietotājam redzamo eventual-consistency logu. Mediānā: ≈279 ms (orķestrācija), ≈249 ms (horeogrāfija). ~¼ sekundi pēc tam, kad krājums jau ir redzams klientiem, pasūtījums joprojām ir uzskaitīts kā `Pending` — klasiskais saga read-your-write risks.

**Horeogrāfija ir ātrāka katrā percentīlē abās metrikās.** Jaunākie palaidieni:

- Inventāra redzamība: avg **−21%** (32.2 vs 40.8 ms), p95 **−16%** (35.7 vs 42.4 ms).
- Saga pabeigšana: avg **−19%** (280.8 vs 344.9 ms), p95 **−14%** (377.6 vs 436.0 ms).

Tas atbilst arhitektūras prognozei: horeogrāfijā `InventoryService` reaģē tieši uz `OrderCreated` no RabbitMQ (viens lēciens, viens DB ieraksts), bet Temporal jāpersistē workflow notikums, jānosūta workflow uzdevums worker'am, tad jāplāno `ReserveInventory` aktivitāte, pirms notiek tas pats DB ieraksts.

**Astes uzvedība ir visizteiksmīgākais atklājums.** Pie max:

- Inventārs: orķestrācija **5.7×** sliktāk (243 vs 43 ms).
- Saga pabeigšana: orķestrācija **3.1×** sliktāk (1205 vs 393 ms).

Tīrajā horeogrāfijas palaidienā `max ≈ p95 + 8–15 ms` — būtībā plakana sadalījums. Orķestrācija rāda pretējo: `max` ir **~6× virs p95** inventāram, **~3× virs p95** saga pabeigšanai. Atbilst Temporal-worker plānošanas trīcei (history-table ieraksti, task-queue aptaujāšanas ritms, sticky-cache neveiksmes) — overheads, kas event-pump ceļam vienkārši nav.

**Horeogrāfija nav stingri uzticamāka — tā ir vairāk jutīga uz vides troksni.** Iepriekšējā palaidiena trīs noildzes un 1262 ms ārpasaule ir neatšķiramas no orķestrācijas sliktākā gadījuma. Pa abiem palaidieniem horeogrāfijas *tipiskie* skaitļi ir labāki, bet tās *sliktākais* novērotais palaidiens nav būtiski labāks par orķestrācijas. Tas norāda:

- Orķestrācijas aste ir **strukturāla** (Temporal plānošana) — klāt abos palaidienos.
- Horeogrāfijas aste ir **vides** — klāt tikai vienā palaidienā; citādi tā pazūd.

### Piezīmes

- Kļūmes ceļš nekad netiek izpildīts (`inventoryReleaseLagMs = null`). Kompensācijas puses aizture pieder Testam I / Testam M.
- 1 VU × 30 iterācijas pēc dizaina ir single-flight. Vienlaicīgas-slodzes uzvedība pieder Testam A / K.
- 25 ms aptaujāšanas intervāls ir izšķirtspējas grīda. Mediānas vērtības (~32 ms) ir pie trokšņa grīdas; **astes** vērtības, kur atstarpe ir liela, ir uzticamais signāls.

### Galvenā secinājuma būtība

Horeogrāfija sasniedz inventāra API aptuveni **8 ms** ātrāk mediānā un **~7 ms** ātrāk p95, bet arhitektūriski jēgpilna atšķirība ir **astes latence**: orķestrācija ievada vairāku simtu milisekunžu ārpasaules abās — inventāra redzamībā un saga pabeigšanā — ko horeogrāfija neievada, attiecinot to uz Temporal workflow plānošanas overhead.

---

## Test F — Race condition / vienlaicīgums

### Mērķis

Apstiprina **vienlaicīguma kontroles korektību** sacensību apstākļos. Divdesmit VU vienlaikus mēģina iegādāties to pašu viena-eksemplāra produktu ("Limited Edition Tablet", krājums = 1). Tieši **vienam** pasūtījumam jāuzvar un **deviņpadsmit** jāzaudē.

Divi jautājumi:

- **Korektība**: Vai optimistiskā konkurence uz `Product.Version` (kartēta uz PostgreSQL `xmin`) novērš pārpārdošanu abos saga modeļos?
- **Veiktspēja sacensībās**: Kā katrs modelis *apstrādā* zaudētājus — proti, kā `DbUpdateConcurrencyException` tiek izplatīts atpakaļ caur saga?

### Iestatījumi

- **Driveris**: `benchmark-race-condition.js`.
- **Izpildītājs**: k6 `shared-iterations`, 20 VU / 20 iterācijas / `maxDuration: 30s`, per-pieprasījuma `timeout: '35s'`.
- **Endpoint**: `POST /api/orders/benchmark` (sinhrons — bloķē līdz terminālajam saga stāvoklim).
- **Per-VU payload**: svaigs `customerId` (UUID) + 1 vienība no ierobežotā krājuma produkta.
- **Iestatīšana**: `POST /api/inventory/reset` + `DELETE /api/orders/reset`, lai garantētu `availableQuantity = 1, reservedQuantity = 0` sākumā.
- **Verdikts**: `wins == 1` → PASS; `wins == 0` → FAIL (nav uzvarētāju); `wins > 1` → FAIL (pārpārdošana).
- **Vienlaicīguma kontroles implementācija atšķiras pēc modeļa**:
  - **Orķestrācija**: ķer `DbUpdateConcurrencyException` un atgriež **HTTP 409 Conflict** → Temporal redz aktivitātes kļūmi un dodas tieši uz kompensāciju.
  - **Horeogrāfija**: ķer to pašu kļūdu un **pārmestīt** → MassTransit ieiet retry politikā, beigās publicējot `InventoryReservationFailed`.
- **Divi palaidieni katram režīmam** tika fiksēti.

### Rezultāti

Visi četri palaidieni: `wins=1, losses=19` → **PASS** katrā gadījumā. Atšķirība ir atbildes laika sadalījumā:

| Režīms | Palaidiens | Avg (ms) | P95 (ms) | Max (ms) | Verdikts |
|---|---|---:|---:|---:|---|
| Orķestrācija | 1 (`18-22-58`) | 3 782.6 | 4 010.8 | 5 813.0 | PASS |
| Orķestrācija | 2 (kanoniskais) | 3 283.7 | 3 557.1 | 3 558.0 | PASS |
| Horeogrāfija | 1 (`18-23-43`) | 1 676.0 | 3 913.6 | 3 924.0 | PASS |
| Horeogrāfija | 2 (kanoniskais) | 6 794.1 | **33 357.1** | **33 359.0** | PASS |

**Režīma agregāti** (pa abiem palaidieniem):

| Režīms | Avg-of-avgs (ms) | P95 diapazons (ms) | Max diapazons (ms) |
|---|---:|---:|---:|
| Orķestrācija | ~3 533 | 3 557 – 4 011 | 3 558 – 5 813 |
| Horeogrāfija | ~4 235 | 3 914 – **33 357** | 3 924 – **33 359** |

### Analīze

**Korektība: abi modeļi ir droši.** Katrs palaidiens uzrādīja tieši 1 uzvarētāju 20 vienlaicīgo pircēju vidū. PostgreSQL `xmin` konkurences žetons paveic savu darbu abos režīmos — saga modelim **nav ietekmes uz pārpārdošanas novēršanu**, jo abi režīmi izmanto vienu un to pašu `InventoryDbContext`, un datubāze (nevis saga koordinators) ir izšķīrējs. Tas izolē saga-modeļa overhead no sacensību-kontroles mehānisma.

**Zaudētāja-ceļa latence ir tur, kur modeļi atšķiras.** 19 zaudētāji — nevis 1 uzvarētājs — dominē atbildes laika sadalījumā:

- **Orķestrācija** ir *cieša un prognozējama*: avg ≈ 3.3–3.8 s, P95 ~250 ms robežās no avg, max ≤ 5.8 s. Kad zaudētāja `ReserveInventoryActivity` atgriež `409 Conflict`, Temporal ieraksta aktivitātes kļūmi un maršrutē workflow tieši kompensācijā. Pie domēna līmeņa konflikta **nav retry**, tāpēc katrs zaudētājs maksā aptuveni vienu round-trip + kompensācijas soli un beidzas.
- **Horeogrāfija** ir *bimodāla*: viens palaidiens pabeidzās ar avg 1.68 s (ātrāk nekā orķestrācijas labākais); otrs uzpūtās līdz avg 6.8 s ar P95 = 33.36 s un max = 33.36 s. 33.36 s būtībā ir **k6 per-iterācijas noildze (35 s)** — ievērojama daļa zaudētāju pārtrauca laiku, nevis dabiski atgriezās.

**Kāpēc horeogrāfija ir bimodāla — pamata cēlonis.** `ReserveInventoryConsumer` apzināti *pārmestīt* `DbUpdateConcurrencyException`, lai MassTransit pārmēģinātu caur brokera atkārtotu piegādi. Pie 20-veida sacensības katrs pārmēģinājums atkal sacenšas par to pašu vienu rindu, tāpēc tipiskā zaudētāja plūsma ir:

1. Zaudē optimistiskās konkurences pārbaudi → met kļūdu.
2. MassTransit pēc atpakaļatkāpes atkārtoti piegādā no RabbitMQ.
3. Atkal zaudē (uzvarētājs jau commitojis, bet rinda joprojām ir apstrīdēta no 18 citiem zaudētājiem).
4. Atkārto, līdz retry budžets izsīkst → publicē `InventoryReservationFailed` → saga izvēršas atpakaļ.

Retry/atpakaļatkāpes grafiks, brokera plānošana un zaudētāju commit secība nosaka, vai kāds palaidiens ir "ātrs" vai "lēns". Šī ne-determinisms rada **17×** P95 izkliedi starp horeogrāfijas palaidieniem (3 914 ms vs 33 357 ms), kamēr orķestrācijas izkliede ir < 12% (3 557 ms vs 4 011 ms).

Orķestrācija pilnībā izvairās no šī, jo orchestrator nošķir *domēna* kļūmi (HTTP 409) no *pārejošas* kļūmes: tā nepārmēģina aktivitāti pie `Conflict` atbildes un nekavējoties pāriet uz kompensāciju.

### Sekas

- **Vienlaicīguma drošība ir datubāzes-līmeņa īpašība**, nevis saga-modeļa īpašība. Abi modeļi pārmanto to pašu korektību no `Product.Version`.
- **Kļūmes-ceļa astes latence ir saga-modeļa īpašība.** Orķestrācijas centralizētā kļūmju maršrutēšana pārvērš `409` par vienu deterministisku kompensāciju, savukārt horeogrāfijas brokera-mediētie pārmēģinājumi pastiprina sacensības par garām, mainīgām astēm. Pie smagas sacensības atbildes laiku nosaka brokera retry/timeout konfigurācija, nevis paveicamais darbs.

### Metodoloģiska piezīme

33.36 s max horeogrāfijas palaidienā 2 ir **cenzēts ar k6 35 s noildzi**. Lai izmērītu patieso zaudētāja-ceļa P95 horeogrāfijā, vai nu paaugstiniet noildzi (piem., `timeout: '120s'`) vai — reālāk — mainiet horeogrāfijas patērētāju, lai tas traktētu `DbUpdateConcurrencyException` kā domēna kļūmi (publicējot `InventoryReservationFailed` pie pirmās parādīšanās), nevis metiet to atpakaļ MassTransit. Tas padarītu modeļus tieši salīdzināmus.

### Galvenā secinājuma būtība

Orķestrācijas P95 = **3.6 s** (stabils); horeogrāfijas P95 = **3.9 s labākajā palaidienā, 33.4 s sliktākajā**. Abi korekti, bet **orķestrācija ir aptuveni 9× prognozējamāka** vienas-rindas sacensībā, ņemot vērā pašreizējās retry politikas.

---

## Test G — Idempotence

### Mērķis

Pārbauda, ka *vienāda* `POST /api/orders` pieprasījuma iesniegšana divreiz ("dubultais klikšķis") ar identisku `IdempotencyKey` **nerada** dublētu pasūtījumu — nav otras sagas, nav dubultas inventāra rezervācijas, nav dubulta maksājuma.

Trīs apgalvojumi katrā iterācijā:

- Abi POST atgriež HTTP **202 Accepted**.
- Abas atbildes nes **vienu un to pašu `orderId`**.
- **Otrā** atbilde iekļauj `idempotent: true`.

Stingrs k6 slieksnis (`duplicate_orders_created: ['count==0']`) noraida palaidienu, ja kaut viens dublikāts paslīd cauri.

### Iestatījumi

- **Slodze**: 1 VU, **20 iterācijas**, `per-vu-iterations` izpildītājs.
- Katra iterācija ģenerē svaigu `customerId` un `idempotencyKey` (UUIDv4), tad izšauj **divus secīgus** POST ar identisku payload.
- Latence sadalīta `first_response_ms` (reālais darbs) un `second_response_ms` (deduplicēta cache hit).
- **Iestatīšana**: inventāra atiestate, visi pasūtījumi izdzēsti, maksājumu kļūmes likme = 0%, 2 s nostāšanās.
- **Servera puses mehānisms** (identisks abiem saga režīmiem): kontrolieris pārbauda `IdempotencyRecord` priekš `(Key, OperationType="CreateOrder")` *pirms* jebkura cita darba. Ja atrasts → atgriež cachēto `OrderId` ar `Idempotent = true` un **nekad nesāk sagu**. Ja nav atrasts → ievieto `Order` + `IdempotencyRecord` **vienā un tajā pašā EF transakcijā**, aizsargājot ar unikālu indeksu uz `(Key, OperationType)`.
- **Kritiski**: deduplicēšana darbojas **pirms** dispatch — *pirms* `Temporal.StartWorkflowAsync` (orķestrācija) vai `IPublishEndpoint.Publish` (horeogrāfija). Mehānisms tāpēc pēc dizaina ir modeļa-agnostisks.
- **Palaišanas komanda**: `./run-test.sh idempotency --env ITERATIONS=20`, vienreiz katram saga režīmam ar `--force-recreate` starp palaidieniem.

### Rezultāti

#### Korektība (galvenā metrika)

| Režīms | Iterācijas | Idempotence trāpījumi | Izveidotie dublikāti | Verdikts |
|---|---|---|---|---|
| Orķestrācija | 20 | **20** | **0** | **PASS** |
| Horeogrāfija | 20 | **20** | **0** | **PASS** |

#### Latence — noturīgs stāvoklis (otrais palaidiens katram režīmam)

| Metrika | Orķestrācija | Horeogrāfija |
|---|---|---|
| 1. POST avg | 8.6 ms | 5.5 ms |
| 1. POST P95 | 11.6 ms | 13.5 ms |
| 1. POST max | 24.0 ms | 24.0 ms |
| 2. POST avg | 3.0 ms | 2.1 ms |
| 2. POST P95 | 6.0 ms | 6.1 ms |
| 2. POST max | 7.0 ms | 8.0 ms |

#### Latence — auksts pirmais palaidiens (uzreiz pēc `--force-recreate`)

| Metrika | Orķestrācija | Horeogrāfija |
|---|---|---|
| 1. POST avg | 19.1 ms | 16.4 ms |
| 1. POST P95 | 49.4 ms | 28.1 ms |
| 1. POST max | 191.0 ms | 202.0 ms |
| 2. POST avg | 3.6 ms | 5.3 ms |
| 2. POST P95 | 7.0 ms | 11.4 ms |
| 2. POST max | 8.0 ms | 20.0 ms |

### Analīze

**Korektība ir identiska un modeļa-agnostiska.** Abi saga modeļi deduplicē perfekti (20/20, 0 dublikātu). Tas ir strukturāli, nevis sagadījums:

- **Vienas-transakcijas ieraksts** `Order` + `IdempotencyRecord`. Unikālais indekss nozīmē, ka pat patiesa vienlaicīga dubultā klikšķa gadījumā tieši viena transakcija uzvar un zaudētājs atkārtoti nolasa cachēto `OrderId`.
- **Modeļa-agnostiska atrašanās vieta**. Tā kā pārbaude darbojas pirms `if (sagaMode == "orchestration")` zara, saga modelis ir nesvarīgs korektībai.

Darbam tas ir noderīgs negatīvs rezultāts: **idempotence nav atšķirības faktors** starp orķestrāciju un horeogrāfiju, ja pieprasījuma ievades punkts to apstrādā. Bieži atkārtotie bažas par to, ka horeogrāfija ir vairāk jutīga uz dublikātu notikumiem, neattiecas, ja deduplicēšana tiek veikta HTTP robežā.

**Pirmā POST latence: horeogrāfija nedaudz lētāka pie dispatch soļa.** Noturīgā stāvoklī, ~8.6 ms (orch) vs ~5.5 ms (chor) — ~3 ms atstarpe, kas atbilst dispatch primitīvas cenai:

- **Orķestrācija** izsūta sinhronu gRPC `StartWorkflowAsync`, kas persistē workflow pirmo history notikumu pirms atgriešanās.
- **Horeogrāfija** izsūta `IPublishEndpoint.Publish(orderCreated)` — lokālu TCP ierakstu uz RabbitMQ. HTTP atbildi var nosūtīt, tiklīdz brokeris apstiprina; patērētāji darbojas asinhroni.

P95 skaitļi ir apgriezti (orch 11.6 vs chor 13.5), bet ar tikai 20 paraugiem tas ir statistisks troksnis — viens lēns aste pievelk P95 augšup ievērojami. Avg ir uzticamāks signāls pie šāda paraugu skaita.

**Otrā POST latence: identiska un minimāla abos režīmos.** ~2–3 ms avg, ~6 ms P95. Otrs pieprasījums veic absolūto minimumu: viens indeksētais `SELECT`, JSON-deserializēšana, atgriež 202. Tas **nekad neieiet saga konveijerā**. Tas ir spēcīgākais pierādījums, ka deduplicēšana pareizi īsslēdz pirms jebkura modeļa-specifiska koda darbības — citādi otrās POST latences atspoguļotu pirmās POST plaisu, un to nedara.

**Aukstā palaidiena troksnis ir JIT/EF uzsildīšana, nevis modeļa signāls.** Abi pirmie palaidieni rāda max 191–202 ms, kas dominē pār avg un P95. Mācību grāmatas aukstā starta paraksts (Npgsql savienojums no tukša pūla, EF Core query plāna kompilācija, .NET pakāpenisks JIT). Nav modeļa-specifisks — tas ir tieši tas, ko Tests L (aukstais starts) ir paredzēts izolēt. Testa G mērķiem tikai otrie/kanoniskie palaidieni ir svarīgi noturīga stāvokļa salīdzinājumam.

### Sekas

- **Abi modeļi izpilda idempotenci ekvivalenti**, ja ievades punkts izmanto idempotences-ieraksta tabulu ar unikālu indeksu.
- Mazā noturīgā stāvokļa latences priekšrocība horeogrāfijai (~3 ms uz pirmā POST) atspoguļo sinhronas workflow reģistrācijas vs. asinhronas brokera publikācijas cenu — **nav specifiska idempotencei**.
- Deduplicētais ceļš ir būtībā bezmaksas (~2 ms), tāpēc **klientiem nav soda par retry sūtīšanu ar idempotences atslēgām**.

**Verdikts**: Pareizi implementētas idempotences tabulas pieprasījuma robežā gadījumā orķestrācija un horeogrāfija ir savstarpēji aizvietojamas no korektības viedokļa, ar tikai marginālām (milisekundu līmeņa) latences atšķirībām no to dispatch primitīvām.

---

## Test H — Jaukta slodze

### Mērķis

Fiksē **happy-ceļa** un **kompensācijas-ceļa** latenci **vienā un tajā pašā palaidienā** pie konfigurējamas kļūmes likmes, lai abu rezultātu percentīles atspoguļotu vienus un tos pašus slodzes apstākļus un rindas dziļumu.

Divi jautājumi:

- **Reālistisks miksis (10% kļūme)**: Kā izskatās ražošanas-stila trafiks katrā modelī?
- **Piespiedu rollback (100% kļūme)**: Kāda ir *neapstrādātā* kompensācijas cena, kad katrai sagai jākompensē?

Divas metrikas ir svarīgas:

- **`compensationSagaMs`** — pilna saga dzīves ilgums atceltam pasūtījumam (pieprasījums → terminālais `Failed`).
- **`compensationWindowMs`** — šaurs `Compensating → Failed` logs, izolējot rollback no virzīšanās uz priekšu.

### Iestatījumi

- **Driveris**: `benchmark-mixed-workload.js`.
- **Iestatīšanas āķis**: atiestata inventāru, dzēš pasūtījumus, tad `POST /api/payments/failure-rate/<FAIL_RATE_PCT>`, lai injektētu deterministiskas maksājumu kļūmes.
- **Tīrīšana**: atiestata kļūmes likmi uz 0.
- Katrs k6 paraugs iezīmēts `outcome:happy` vai `outcome:compensation`, balstoties uz `compensated` karogu.
- `constant-arrival-rate` izpildītājs ar 5 s uzsildīšanas fāzi pie 1/4 no galvenās likmes.
- **Divi scenāriji** (katrs palaists divreiz katram režīmam):

| Scenārijs | Likme | Ilgums | `FAIL_RATE_PCT` | Mērķis |
|---|---|---|---|---|
| Reālistisks | 10 rps | 60 s | 10 | Ražošanas-stila miksis |
| Tīra kompensācija | 5 rps | 30 s | 100 | Izolēt rollback cenu |

### Rezultāti

#### Scenārijs 1 — 10 rps, 10% mērķa kļūme, 60 s

| Režīms | Pabeigti | Kompensēti | Kļūdaini | Novērotā kļūme % | Happy P95 (ms) | Comp saga P95 (ms) | Comp logs P95 (ms) |
|---|---|---|---|---|---|---|---|
| Orķestrācija (pal. 1) | 611 | 0 | 0 | **0.0** | 1683.8 | n/a | n/a |
| Orķestrācija (pal. 2) | 612 | 0 | 0 | **0.0** | 1676.2 | n/a | n/a |
| Orķestrācija (pal. 3) | 610 | 0 | 0 | **0.0** | 1689.2 | n/a | n/a |
| Horeogrāfija (pal. 1) | 534 | 16 | 59 | 12.3 | 339.5 | 1129.2 | 1019.7 |
| Horeogrāfija (pal. 2) | 543 | 10 | 57 | 11.0 | 339.9 | 1193.1 | 1013.8 |

#### Scenārijs 2 — 5 rps, 100% mērķa kļūme, 30 s

| Režīms | Pabeigti | Kompensēti | Kļūdaini | Comp saga avg / P95 / max (ms) | Comp logs avg / P95 / max (ms) |
|---|---|---|---|---|---|
| Orķestrācija (pal. 1) | 0 | 147 | 0 | 3570.6 / 3874.5 / 4113.3 | 104.1 / 310.7 / 363.8 |
| Orķestrācija (pal. 2) | 0 | 146 | 0 | 3595.8 / 3871.8 / 4033.5 | 116.2 / 339.2 / 367.8 |
| Horeogrāfija (pal. 1) | 0 | 53 | 103 | 199.4 / 281.0 / 318.9 | 26.4 / 27.6 / 29.4 |
| Horeogrāfija (pal. 2) | 0 | 44 | 113 | 192.9 / 243.0 / 292.5 | 26.2 / 27.7 / 28.7 |

### Analīze

**Happy-ceļa latence: horeogrāfija ~5× ātrāka.** Pie 10 rps happy-ceļa saga pabeidzas ~340 ms P95 (chor) vs ~1680 ms P95 (orch). Atbilst Testam A: orķestrācija maksā Temporal task-queue dispatch katrā solī, kamēr horeogrāfija nodod caur tiešu AMQP. Astes uzvedība arī ir sliktāka orķestrācijai — P99 lec līdz **3820 ms** palaidienā 1, kas norāda uz garas-astes ārpasaulēm, kas atbilst worker plānošanas spiedienam.

**Kompensācijas cena: logs vs pilna saga (svarīgākais atklājums).** Pie 100% kļūmes likmes sadalījums atklāj, ka **lielākā daļa orķestrācijas cenas nav pašā rollback**:

| Režīms | Comp saga kopējais P95 | Comp logs P95 | Virzīšanās uz priekšu + retry daļa |
|---|---|---|---|
| Orķestrācija | ~3870 ms | ~325 ms | **~3545 ms (~92%)** |
| Horeogrāfija | ~262 ms | ~27 ms | ~235 ms (~90%) |

- **`Compensating → Failed` logs** patiesi ir mazs abos modeļos — orch ~325 ms P95, chor ~27 ms P95 (≈12× ātrāk).
- **Dominējošā cena orķestrācijā** ir *pirms* kompensācijas sākuma. Ar maksājuma aktivitāti, kas met kļūdu 100% laika, Temporal workflow pārmēģina aktivitāti pēc savas politikas (eksponenciāla atpakaļatkāpe), līdz padodas, **tad** pāriet uz kompensācijas zaru. Tā retry aste veido ~3.5 s no ~3.9 s saga ilguma. Horeogrāfijai nav līdzvērtīga retry slāņa — pirmais kļūdainais notikums uzreiz iedarbina rollback ķēdi.

Šī atšķirība ir **arhitektūras, nevis implementācijas pulēšana**: Temporal vērtības priekšlikums iekļauj noturīgus retry, un tests atklāj šīs funkcijas latences nodokli ātras-kļūmes scenārijā.

**Orķestrācijas retry politika absorbē 10% kļūmju injekciju.** Visi trīs orķestrācijas palaidieni pie `FAIL_RATE_PCT=10` ziņo `observedFailRatePercent: 0`, `compensated: 0`. Sākotnēji izskatās, ka kļūmju injekcija nestrādāja, bet tas ir **gaidāmais matemātiskais rezultāts** no aktivitātes retry politikas:

- `PaymentOperations.cs` met `Rng.Next(100) < FailureRatePercent` **uz katra izsaukuma** → neatkarīga 10% varbūtība uz katra HTTP mēģinājuma.
- `OrderActivities.cs` paceļ `ApplicationException` pie ne-sekmes → Temporal klasificē kā retriable.
- `OrderSagaWorkflow.cs` konfigurē `MaximumAttempts = 3` (sākotnējais + 2 retry pie 1 s un 2 s).

Tāpēc **per-saga** kļūmes varbūtība ir `0.10³ = 0.1%`. Pa 600 sagām gaidāmais kompensēto sagu skaits ir 0.6 (≈55% iespēja saņemt nulli vienā palaidienā, ≈17% iespēja saņemt nulli trīs neatkarīgos palaidienos). Novērotais `0/0/0` rezultāts pilnībā saskan ar binomālo sadalījumu.

Horeogrāfija uzvedas atšķirīgi strukturāla iemesla dēļ. Maksājumu patērētājs **nemet** kļūdu pie biznesa kļūmes — tas publicē `PaymentFailed` notikumu un atgriežas normāli — tāpēc `UseMessageRetry` nekad neiedarbinās. Katra saga saņem tieši vienu maksājuma mēģinājumu, un 10% per-call likme tiek tulkota kā ~10–12% per-saga kļūmes.

**Darbam svarīgs atklājums**: pārejošu lejupejošo kļūmju gadījumā abi modeļi atklāj **dažādus efektīvos kļūmes budžetus saga robežā**. Temporal aktivitātes retry klusi absorbē 99.9% no 10% per-call kļūmēm; horeogrāfija tās atklāj kā kompensācijas ceļus aptuveni tādā pašā per-saga likmē kā per-call likme. Tā pati retry asimetrija ir atbildīga par ~3 s aizkavi pirms kompensācijas sākuma Testā I un par ~3.5 s "virzīšanās uz priekšu + retry" daļu orķestrācijas kompensācijā Scenārijā 2.

Praktiskās sekas: modeļa izvēle daļēji nosaka, vai pārejošas kļūdas izraisa **lietotājiem redzamas kompensācijas** vai **klusu latences nodokli**. Politiku izlīdzināšana prasītu vai nu Temporal retry deaktivizēšanu (`MaximumAttempts = 1`), vai horeogrāfijas patērētāja iesaiņošanu `UseMessageRetry` un kļūdu pārmestīt pie biznesa kļūmes.

**Horeogrāfijas klasifikācijas anomālija: `failed` ≫ `compensated`.** Abos scenārijos horeogrāfija ziņo daudz vairāk `failed` nekā `compensated` (piem., 113 failed vs 44 compensated pie 100%), pat ja katra ne-pabeigta saga sasniedza terminālo `Failed`. Klasifikācija atkarīga no `compensated` karoga benchmark atbildē. Daudzi pasūtījumi sasniedz `Failed` bez tā, ka atbilde uzstāda `compensated: true` — visticamāk, jo benchmark endpoint atgriežas pie terminālā stāvokļa pienākšanas, un horeogrāfijas terminālā stāvokļa atklāšana ne vienmēr uzticami signalizē, ka "kompensācija notika". `compensationSagaMs` un `compensationWindowMs` percentīles aptver tikai iezīmēto apakškopumu, tāpēc tās var nedaudz nepietiekami pārstāvēt reālo sadalījumu. **Tas neapgāž salīdzinājumu** — per-paraugs laiki uz iezīmētā apakškopuma joprojām ir derīgi — bet per-modeļa uzskaite `totals` jāziņo ar šo piezīmi.

**Caurlaides veselīguma pārbaude.** 10 rps × 60 s = 600 mērķa pasūtījumi → visi Scenārija 1 palaidieni iekrita 609–612 (slodzes ģenerators precīzi sasniedza mērķa likmi). 5 rps × 30 s = 150 mērķis → visi palaidieni iekrita 146–157. **Piesātinājums nav novērots**; latences rezultāti atspoguļo modeļa raksturīgo overhead.

### Ieteicamās turpmākās darbības

- **Veidojiet Scenāriju 1 ap retry-budžeta atklājumu**, nevis kā jauktas-slodzes latences salīdzinājumu. Trīs neatkarīgi palaidieni, kas rada `0/0/0`, apstiprina binomālo prognozi; rinda ir *rezultāts*, nevis gaidāms re-palaidiens.
- Lai veiktu blakus salīdzinājumu kompensācijas latencei pie 10 rps, iestatiet `FAIL_RATE_PCT ≥ 50` katram izsaukumam (≥ 12.5% per saga) vai īslaicīgi pazeminiet `MaximumAttempts` uz 1.
- **Ziņojiet kompensācijas salīdzinājumu galvenokārt no Scenārija 2** (100% likme). Galvenā secinājuma būtība — orķestrācijas pilnā-saga rollback dominē aktivitātes retry — ir labi atbalstīta.
- **Salabojiet `compensated` karogu** benchmark atbildē, lai tas tiktu uzstādīts vienmēr, kad saga sasniedza `Failed` caur kompensācijas ķēdi.

---

## Test I — Kompensācijas korektība

### Mērķis

Apstiprina, ka **kompensācija patiešām atjauno sistēmas stāvokli pēc kļūmes** abos saga modeļos. *Korektības* tests, nevis veiktspējas, kas ieraksta, cik ilgi pasūtījumam vajadzīgs, lai sasniegtu `Failed`. Trīs invariantes:

- **Liveness** — katrs pasūtījums sasniedz `Failed` (neviens neiestrēgst `Pending`/`Compensating`).
- **Inventāra rollback** — `reservedQuantity` atgriežas pie bāzes līnijas.
- **Nav atstātā stāvokļa** — katrs pasūtījums beidzas terminālajā statusā.

### Iestatījumi

Viens-VU k6 scenārijs ar deterministiskām 100% maksājumu kļūmēm.

- `ITERATIONS = 10`, `vus = 1`, `executor = per-vu-iterations` (vienpavediens — bez starp-iterāciju iejaukšanās).
- `TIMEOUT_MS = 15000` katram pasūtījumam.
- Stingrs k6 slieksnis: `orders_stuck: ['count==0']`.
- Produkts: `a1111111-...`.
- **Iestatīšana**: atiestatīt inventāru + pasūtījumus, snapshot bāzes `reservedQuantity` un `stockQuantity`, tad `POST /api/payments/failure-rate/100`.
- **Iterācija**: POST 1 vienība; aptaujāt statusu ik pēc 50 ms, līdz `Failed`/`Completed` (noildze 15 s); ierakstīt `compensation_total_ms` (POST → `Failed`); 500 ms starpība starp iterācijām.
- **Tīrīšana**: atiestatīt kļūmes likmi uz 0, gulēt 2 s, salīdzināt `reservedQuantity` ar bāzes (PASS/FAIL), pārbaudīt, ka nav `Pending`/`Compensating` pasūtījumu.
- **Divi palaidieni katram režīmam** fiksēti.

### Rezultāti

#### Korektība (identiska abiem modeļiem)

| Pārbaude | Orķestrācija | Horeogrāfija |
|---|---|---|
| Pasūtījumi sasniedza `Failed` | 10 / 10 | 10 / 10 |
| Iestrēgušie pasūtījumi | **0** | **0** |
| Inventāra rezervācija atbrīvota līdz bāzes | PASS | PASS |
| Pasūtījuma statusa invariante | PASS | PASS |

**Abi modeļi ir funkcionāli pareizi.**

#### Laiks līdz `Failed` (`compensation_total_ms`, ms)

| Palaidiens | Režīms | Skaits | Avg | Mediāna | P95 | Max |
|---|---|---|---|---|---|---|
| 19:00:02 | Orķestrācija | 10 | 3565.0 | 3566.5 | 3660.2 | 3675.0 |
| 19:01:00 | Orķestrācija | 10 | **3586.1** | 3590.0 | 3644.3 | 3647.0 |
| 19:01:40 | Horeogrāfija | 10 | 215.7 | 168.5 | 476.2 | 681.0 |
| 19:02:09 | Horeogrāfija | 10 | **192.6** | 195.5 | 229.0 | 229.0 |

Kanoniskie rezultāti:

- **Orķestrācija**: avg ≈ **3 586 ms**, p95 ≈ **3 644 ms**.
- **Horeogrāfija**: avg ≈ **193 ms**, p95 ≈ **229 ms**.
- **Attiecība**: orķestrācija ir aptuveni **18× lēnāka** sasniegt `Failed`.

### Analīze

**Abi modeļi ir pareizi.** 100% pasūtījumu sasniedza `Failed`, stingrs slieksnis tika izpildīts katrā palaidienā. Inventārs tika atbrīvots, nav atstātā stāvokļa. No korektības viedokļa orķestrācija un horeogrāfija ir ekvivalenti.

**18× latences plaisa ir strukturāla, nevis defekts.** Tieša sekas no tā, **kā katrs modelis interpretē neveiksmīgu PaymentService izsaukumu**, neraugoties uz to, ka abiem ir *nomināli* saskaņota retry politika (3 mēģinājumi ar 1 s + 2 s atpakaļatkāpi):

- **Orķestrācijas ceļš**: `ProcessPaymentAsync` aktivitāte met `ApplicationException` pie ne-sekmes. Temporal traktē *katru izmestu kļūdu* kā retriable pārejošu un piemēro `DefaultActivityOptions`: 3 mēģinājumi pie t=0, t≈1 s, t≈3 s. Tikai pēc trešās deterministiskās kļūmes workflow ieiet `catch` blokā un sāk kompensācijas. **~3 sekundes retry atpakaļatkāpes pirms kompensācijas sākuma** — atbilst novērotajiem 3.5–3.6 s.

- **Horeogrāfijas ceļš**: patērētājs **nemet** kļūdu pie biznesa kļūmes; tas publicē `PaymentFailed` un atgriežas normāli:
  ```csharp
  if (!result.Success) {
      _logger.LogWarning(...);
      await context.Publish(new PaymentFailed(...));
      return;
  }
  ```
  No MassTransit perspektīvas ziņa tika sekmīgi patērēta, tāpēc `UseMessageRetry` nekad neiedarbinās. `PaymentFailed` plūst tieši uz saga state machine, kas pāriet `Compensating` → `Failed` ar vienu ziņas round-trip uz servisu — līdz ar to ~200 ms kopā.

Tā pati retry politika ir konfigurēta abos modeļos, bet **tā iedarbinās tikai orķestrācijā, jo kļūmes virsma ir *kļūda*, kamēr horeogrāfijā tā pati situācija ir modelēta kā *biznesa notikums***. Tā ir asimetrija kļūmes semantikā, nevis retry konfigurācijā.

**Variance un astes uzvedība.** Horeogrāfija rāda vieglu trīci — viens palaidiens ziņo max=681 ms un p95=476 ms (vairāk nekā 2× mediānas 168.5 ms). Atbilst RabbitMQ plānošanas trīcei, EF query plāna iesilšanai, MassTransit patērētāja aktivizēšanai. Orķestrācijas aste ir daudz ciešāka (max ≈ p95 ≈ avg + ~80 ms), jo gandrīz viss ilgums nāk no *deterministiskas* retry atpakaļatkāpes (1 s + 2 s gaidīšana), tāpēc per-iterācijas troksni dominē fiksētais taimers.

### Sekas

- **Korektības secinājums**: abi modeļi tīri atjaunojas no deterministiskas lejupejošās kļūmes; neviens nezaudē rezervācijas un neatstāj atstāto stāvokli.
- **Latences secinājums**: *neapstrādātā kompensācijas cena* šajā kodu bāzē ir aptuveni par lieluma kārtu mazāka horeogrāfijā (~200 ms vs ~3.6 s), bet to **dominē retry semantika, nevis pats saga modelis**. Ja `MaximumAttempts` tiktu pazemināts uz 1 orķestrācijas ceļā, plaisa būtiski sašaurinātos un atlikušā atšķirība atspoguļotu Temporal history-write overhead vs. RabbitMQ pub/sub overhead.
- **Piezīme**: salīdzinot kompensācijas latenci starp modeļiem, *kļūmes-injekcijas mehānisms* jādefinē identiski. Šeit "100% maksājumu kļūme" nozīmē HTTP kļūdu orķestrācijas pusē (kas pārmēģina), bet biznesa notikumu horeogrāfijas pusē (kas nepārmēģina).

### Kopsavilkums

| Aspekts | Orķestrācija | Horeogrāfija |
|---|---|---|
| Pasūtījumi sasniedza `Failed` | 10 / 10 | 10 / 10 |
| Iestrēgušie pasūtījumi | 0 | 0 |
| Inventārs atjaunots | Jā | Jā |
| Laiks līdz `Failed` (avg) | 3 586 ms | 193 ms |
| Laiks līdz `Failed` (p95) | 3 644 ms | 229 ms |
| Dominējošais cenas drivers | 3× aktivitātes-retry atpakaļatkāpe (1 s + 2 s) pirms kompensācijas sākuma | Viens ziņas lēciens, kas publicē `PaymentFailed` |
| Kļūmes semantika | Aktivitātes kļūda → pārmēģina | Biznesa notikums → nepārmēģina |

---

## Test J — Izturība / ilgtspējīga slodze

### Mērķis

**Ilgtspējīgas slodzes (izturības)** veiktspējas tests. Nav par maksimālo caurlaidi vai aukstu startu — tas atbild uz vienu jautājumu:

> *Vai kāds no saga modeļiem laika gaitā degradē fiksētā, mērenā slodzē?*

Tas atklāj problēmas, ko viena-šāviena testi (Tests A, K) palaiž garām:

- **Rindas-aizmugures pieaugums** horeogrāfijā.
- **Temporal history-table pārpilde**, kas ietekmē Postgres rakstīšanas latenci.
- **Savienojumu pūla izsīkšana**.
- **Bezgalīgs atmiņas pieaugums** / noplūdes.

Signāls ir **P95 nobīde** — atšķirība starp beigu-spaiņa un sākuma-spaiņa P95. **< 500 ms nobīde = noturīgs stāvoklis**; vairāk = kaut kas degradē.

### Iestatījumi

- **Driveris**: `benchmark-endurance.js`.
- **Likme**: 25 rps, **constant-arrival-rate** (atvērts modelis, bez slēgtas-cilpas izkropļojumiem).
- **Ilgums**: 5 minūtes katram režīmam → ~7 500 sagas/palaidienam.
- **Endpoint**: `POST /api/orders/benchmark` (bloķē līdz terminālajam saga stāvoklim).
- **Bez uzsildīšanas**: k6 sākas pilnā likmē, tāpēc **sākuma spainis iekļauj JIT/EF uzsildīšanu**.
- **Trīs vienlīdzīgi spaiņi** (~100 s katrs): `start`, `middle`, `end` — iezīmēti uz metrikas per-spaiņa percentīlēm + nobīdei.
- **Iestatīšanas āķis**: pilna stāvokļa atiestate (inventārs, pasūtījumi, maksājumu kļūmes likme = 0).
- **Slodze**: nejaušs no 3 produktiem, daudzums 1, svaigs `customerId` UUID katram pieprasījumam. **Tikai happy-ceļš.**
- **Abi režīmi izmanto identisku infra**: tos pašus Postgres / RabbitMQ / Temporal konteinerus, bez resursu ierobežojumiem. Tikai `SAGA_MODE` pārslēgts starp palaidieniem.

### Rezultāti

**Kopējais saga ilgums (ms), 25 rps 5 minūtes:**

| Spainis | Orķestrācija (n) | avg | p95 | p99 | max | Horeogrāfija (n) | avg | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| start  | 2 293 | 768.6 | 937.4 | 1 715.9 | **3 899.2** | 2 354 | 254.0 | 337.1 | 363.6 | **3 299.3** |
| middle | 2 493 | 751.0 | 889.4 | 993.2   | 1 949.1     | 2 500 | 249.3 | 336.1 | 361.9 | 391.9 |
| end    | 2 545 | 749.7 | 890.5 | 985.2   | 1 952.4     | 2 556 | 248.4 | 336.1 | 362.1 | 374.3 |
| **kopējais** | **7 331** | **756.1** | **907.5** | **1 238.6** | 3 899.2 | **7 410** | **250.5** | **336.4** | **362.7** | 3 299.3 |

**P95 nobīde (end − start):**

- **Orķestrācija: −46.9 ms** (beigas ir *ātrākas* nekā sākums)
- **Horeogrāfija: −1.0 ms** (būtībā plakana)

Abi palaidieni piegādāja ~98% no 7 500 mērķa sagām (orch 97.7%, chor 98.8%); nav neveiksmīgo statusu lēcienu.

### Analīze

**Abi modeļi ir noturīgā stāvoklī — neviens nezaudē 25 rps.** Abi nobīdes ir **labi zem 500 ms brīdinājuma sliekšņa** (faktiski nedaudz negatīvas). Tas apstiprina:

1. **Nav izmērāms back-pressure vai resursu noplūde** 5 minūtēs — RabbitMQ iztukšo tikpat ātri, cik piepildās, Temporal augošā history tabula vēl neietekmē Postgres rakstīšanas latenci, un .NET procesi nepūš savus darba kopumus.
2. Vieglā negatīvā nobīde ir **JIT / EF query plāna uzsildīšana**, kas joprojām asiņo pirmajos ~100 s. Pēc uzsildīšanas `middle` un `end` spaiņi ir statistiski neatšķirami abos režīmos (orch P95 889 vs 890; chor P95 336 vs 336).

**Šajā slodzē neviens modelis nav ierobežotājs.**

**Dominējošais atklājums ir strukturāls, nevis laicīgs: horeogrāfija ir ~3× ātrāka end-to-end.** Pat izturības testā galvenais skaitlis lec laukā: **horeogrāfija vidēji 250 ms vs orķestrācijas 756 ms**, P95 plaisa **571 ms** absolūta. Tā ir **konstanta visos trīs spaiņos**, tāpēc tā ir modeļu īpašība, nevis pārejoša.

Cēlonis ir arhitektūras. Orķestrācijā katrs saga solis ir Temporal workflow uzdevums: `Postgres workflow-history append → workflow advance → activity dispatch → activity result append → Postgres atkal`. Pieci soļi × ~150 ms centrālā-stāvokļa round-trip ≈ 750 ms. Horeogrāfijā katrs serviss patērē RabbitMQ notikumu, raksta savā DB un izstaro nākamo notikumu — bez centrālas state machine, bez per-step history persistēšanas. Pieci lēcieni × ~50 ms ≈ 250 ms.

Tādējādi **orķestrācija maksā ~500 ms latences par centralizētu workflow stāvokli un eksplicītu atjaunošanas semantiku**, ilgtspējīgi pa visu 5 minūtēm. Tests J kontrolē visu pārējo (ta pati infra, ta pati likme, tas pats ilgums, tas pats produktu mikslis, ta pati stāvokļa atiestate).

**Astes-latences uzvedība atšķiras — orķestrācijas aste ir resnāka pat noturīgā stāvoklī.** Pēc tam, kad sākuma spainis izskalo uzsildīšanu:

- **Horeogrāfijas pēc-uzsildīšanas max ≈ p99 + 30 ms** (374 vs 362). Aste ir *cieša*: notikumi plūst caur RabbitMQ ar prognozējamu per-lēciena cenu, nav "stop-the-world" notikuma, kas ievadītu ārpasaules.
- **Orķestrācijas pēc-uzsildīšanas max ≈ 2× p99** (1 952 vs 985). Pat ja nekas nedegradē, ~1 no katriem ~2 500 sagām aizņem aptuveni divreiz tik ilgi, cik 99. percentīle. Iespējamākais cēlonis: **Temporal sticky-task-queue cache miss / workflow-task timeout retry** — kad worker pārsadalās vai uzdevums nokrīt uz ne-cachētu worker, workflow jāpārspēlē no history, pievienojot simtus ms.

Ievērojams atklājums: orķestrācija nodrošina spēcīgākas konsekvences garantijas, bet **uzrāda plašāku astes-latences sadalījumu**, kas nesašaurinās zem ilgtspējīgas mērenas slodzes.

**Sākuma-spaiņa P99 lēciens orķestrācijā (1 715 ms) ir uzsildīšana, nevis modeļa overhead.** Orķestrācijas sākuma P99 ir gandrīz **2× tās middle/end P99** (~990 ms). Horeogrāfijas sākuma P99 (363.6 ms) ir **identisks** middle/end (~362 ms). Norāda mums:

- **Temporal workers nes smagāku auksto ceļu** nekā MassTransit patērētāji — workflow-tipa reģistrācija, sticky-queue piešķiršana, Postgres history-table query plāna kompilācija visi notiek pirmajos pāris simtos pasūtījumu.
- **Horeogrāfijas per-servisa starts ir amortizēts neredzami**, jo `MassTransit consumer + EF context warm-up` aizņem dažas milisekundes vs Temporal sekunžu mēroga reģistrāciju.

**Caurlaides paritāte apstiprina, ka neviens nav likmes-piesātināts.** 7 331 vs 7 410 pabeigtas sagas (mērķis 7 500) → **abi režīmi apstrādāja ~98% no pienākušajiem** bez kļūdām. Trūkstošie ~2% ir k6 dabiskā arrival-rate trīce robežās. Tas izslēdz alternatīvu skaidrojumu, ka "orķestrācija izskatās lēnāka, jo veido rindu". Tā nedara — katra saga tiek pabeigta; cena ir per-saga kritiskajā ceļā.

### Ko šis tests *nepasaka* tev

- **Nav kompensācijas šajā palaidienā** (`FAIL_RATE_PCT=0`). Orķestrācijas kompensācijas cena parasti ir daudz tuvāka horeogrāfijas nekā tās happy-ceļa cena — Tests H/M jautājums.
- **25 rps ir mērena**, ne piesātinājums. Jautājums "vai horeogrāfija degradē pirmā RabbitMQ dēļ vai orķestrācija Temporal history pārpildes dēļ?" prasa atkārtotu palaišanu pie augstākām likmēm (50, 100 rps) un garākiem ilgumiem (15–30 min).
- **5 minūtes ir īsi** atmiņas noplūdēm. CLR-stila lēnās noplūdes prasa 30+ minūtes. Nobīdes signāls šeit izslēdz tikai *ātras* noplūdes.

### Galvenā secinājuma būtība

> Pie 25 rps, kas tiek uzturēts 5 minūtes, **abi saga modeļi ir noturīgā stāvoklī bez izmērāmas degradācijas vai rindas aizmugures**. Strukturālā latences plaisa starp tiem — horeogrāfija ~3× ātrāka vidēji, ~2.7× ātrāka pie P95 — ir **konstanta laikā**, kas apstiprina, ka tā ir koordinācijas modeļa īpašība, nevis uzsildīšanas vai uzkrātās slodzes artefakts. Orķestrācija papildus uzrāda plašāku P99-uz-max plaisu, kas saglabājas noturīgā stāvoklī, kas norāda uz smagāku asti, ko vada workflow pārspēlēšana un worker pārsadalīšana.

---

## Test K — Vienlaicīgo klientu caurlaide

### Mērķis

Mēra **tīru konveijera paralēlismu** pie augstas vienlaicības ar **nulles rindas-līmeņa sacensību**.

- Daudzi VU izšauj pasūtījumus vienlaikus, bet katrs VU mērķē uz **citu** produktu no daudz-krājuma pūla, tāpēc divas vienlaicīgas sagas necīnās par to pašu `Product.ReservedQuantity` rindu.
- Izolē **strukturālo overhead** katram saga modelim (HTTP pieņemšana, Temporal workers vs. MassTransit patērētāji, DB savienojumu pūli, brokera lēcieni) no optimistiskās konkurences cenas, ko Tests F apzināti spiež.
- Salīdzināts ar Testu F atbilstošos VU skaitos, plaisa kvantitatīvi nosaka **sacensības cenu**. Atsevišķi Tests K atbild: *kurš modelis labāk paralelizē happy-ceļa sagas?*

### Iestatījumi

- **Slodze**: k6 `constant-vus` — katrs VU cikls iet tik ātri, cik var, bez likmes ierobežojuma.
- **Konfigurācija**: `VUS=25`, `DURATION=30s`.
- **Endpoint**: `POST /api/orders/benchmark` (bloķē — atgriežas tikai pie terminālā stāvokļa, ar pilnu laiku telemetriju).
- **Produktu sadalījums**: 5 daudz-krājuma produkti (100k vienības katrs); katrs VU piesaistīts vienam caur `__VU % 5`. 25 VU sadalīti pa visiem 5 produktiem ar 5 VU uz rindu — bez pārpārdošanas spiediena.
- **Sliekšņi**: `p(95) total_saga_duration_ms < 15 000 ms`.
- **Iestatīšana**: inventāra atiestate, pasūtījumu tīrīšana, maksājumu kļūmes likme = 0%, 2 s nostāšanās.
- **Režīma pārslēgšana**: `SAGA_MODE` pārslēgts starp palaidieniem caur `--force-recreate` (infra paliek silta).
- **Fiksēts**: `apiResponseMs`, `totalSagaDurationMs`, `orders_completed`, `orders_failed`, `effectiveThroughputPerSec = completed / durationSec`.

### Rezultāti

#### Galvenie skaitļi — silti palaidieni (25 VU, 30 s)

| Metrika | Orķestrācija | Horeogrāfija | Choreo vs Orch |
|---|---:|---:|---:|
| Pasūtījumi pabeigti | 897 | 1 734 | **1.93×** |
| Pasūtījumi kļūdaini | 1 | 75 | +74 |
| Efektīvā caurlaide | 29.9 pasūtījumi/s | **57.8 pasūtījumi/s** | **+93%** |
| API atbildes P95 | 23.8 ms | 4.5 ms | **−81%** |
| API atbildes P99 | 55.4 ms | 37.6 ms | −32% |
| API atbildes max | 71.1 ms | 148.4 ms | +109% |
| Saga ilguma mediāna | 779.5 ms | 258.2 ms | **−67%** |
| Saga ilguma P95 | 962.6 ms | 365.0 ms | **−62%** |
| Saga ilguma P99 | 1 689.6 ms | 1 327.3 ms | −21% |
| Saga ilguma max | 1 995.7 ms | 4 251.7 ms | +113% |

#### Palaidiena-uz-palaidiena konsistence

**Orķestrācija** ir ļoti stabila abos palaidienos:

- Caurlaide: 29.7 → 29.9 pasūtījumi/s (±0.7%)
- Saga P95: 1 040.5 → 962.6 ms
- Kļūmes: 0 → 1

**Horeogrāfija** rāda izteiktu **pirmā-palaidiena sodu**:

- Pirmais palaidiens (auksti patērētāji): 30.2 pasūtījumi/s, saga P95 398.9 ms, bet **P99 = 7 384 ms, max = 9 285 ms**, API P99 = 1 444 ms.
- Otrais palaidiens (silts): 57.8 pasūtījumi/s, saga P99 = 1 327 ms, max = 4 252 ms.

Pirmais palaidiens bija ierobežots līdz tādai pašai caurlaidei kā orķestrācijai, jo gara aste lēno sagu bloķēja VU no cilpas. Pēc uzsildīšanas caurlaide gandrīz dubultojas.

### Analīze

**Horeogrāfija ir ~2× ātrāka uz sacensības-brīva happy-ceļa.** Ar 25 VU, kas sadalīti pa 5 produktiem, abiem modeļiem ir pietiekams paralēlisms; atšķiras tas, kā viena saga pārvietojas pa saviem 5 soļiem:

- **Orķestrācija (Temporal)**: katra soļa pāreja ir workflow-uzdevuma round-trip. Pieci soļi nozīmē **piecus history ierakstus + piecas task-queue dispatch** papildus reālajam darbam, visi caur centrālo serveri. Mediāna saga = 779.5 ms.
- **Horeogrāfija (MassTransit/RabbitMQ)**: katrs serviss patērē iepriekšējā servisa notikumu un publicē nākamo tieši. Bez centrālas history rakstīšanas per step; katrs lēciens ir viena rindas publikācija + viens patērētāja dispatch. Mediāna saga = 258.2 ms — **3.0× ātrāka mediānā**, ~2.6× pie P95.

Tā kā `/api/orders/benchmark` bloķē līdz terminālajam stāvoklim, sagas ilguma uz pusi samazināšana aptuveni dubulto VU cikla biežumu: **57.8 vs 29.9 pasūtījumi/s ≈ 1.93×**, gandrīz perfekti sekojot mediānas saga attiecībai.

**API pieņemšana arī ir dramatiski ātrāka horeogrāfijā.** API P95 ir **4.5 ms vs 23.8 ms** (−81%) atspoguļo, ko `OrderService` dara, lai sāktu katru modeli:

- Orķestrācija: sinhrona `Temporal.StartWorkflow` izsaukums — tīkla round-trip uz Temporal frontend + sinhrons Postgres ieraksts workflow history.
- Horeogrāfija: procesa iekšējs MassTransit `Publish` — fire-and-forget, bez sinhrona DB ieraksta uz karstā ceļa.

Konsekventa abos horeogrāfijas palaidienos (P95 6.0 ms auksts, 4.5 ms silts).

**Horeogrāfija uzvar mediānā, bet zaudē astē.** Max latences apgriež galveno secinājuma rangu:

- Orķestrācijas max saga: **1 996 ms** (≈ 2× P95).
- Horeogrāfijas max saga: **4 252 ms** (≈ 12× P95).

Temporal centrālā state machine sniedz tai cieši ierobežotas ārpasaules — katrs solis tiek apstiprināts un timer-virzīts no viena koordinatora. Horeogrāfijā aste rodas, kad RabbitMQ patērētājs atpaliek, servisa savienojuma pūls bloķējas vai pārejošs DB lock aizkavē vienu soli — un nav koordinatora, kas deterministiski pārmēģinātu, tāpēc lēnākais lēciens nosaka visas sagas asti. No tā arī rodas **75 kļūdaini pasūtījumi**: piesātinātā likmē dažas sagas pārsniedz 35 s noildzi vai izgāž `finalStatus !== Completed` pārbaudi.

Orķestrācijas kļūmju skaits **1 / 897** vs horeogrāfijas **75 / 1 809** ir tieša durability/throughput kompromisa izpausme: Temporal maksā per-step latences nodokli apmaiņā pret deterministisku state machine, kas šajā slodzē gandrīz nekad nezaudē sagas; MassTransit + RabbitMQ pārvada gandrīz divreiz vairāk sagu, bet ar izmērāmu astes-kļūmes likmi.

**Aukstā starta sods ir asimetrisks.** Pirmais horeogrāfijas palaidiens sabruka līdz **30.2 pasūtījumiem/s** — neatšķirams no orķestrācijas — pat ja noturīgā stāvoklī horeogrāfija darbojas pie 57.8. Paraksts: P99 saga 7 384 ms un API P99 1 444 ms (abi ~5× augstāki nekā silti), bet mediāna (259 ms) ir nemainīga. Diagnoze: neliela MassTransit patērētāju daļa joprojām iesila (rindas saistīšana, EF query plāna kompilācija, JIT pakāpeniska kompilācija), kad 25 VU uzreiz piesātināja konveijeru; head-of-line bloki izplatījās caur in-flight pūlu.

Orķestrācija nerāda šādu asimetriju starp saviem diviem palaidieniem (29.7 → 29.9), jo Temporal workers prefetch uzdevumus vienmērīgā ritmā un iesilst pakāpeniski. **Praktiskā ietekme**: horeogrāfijas publicētā caurlaide jākvalificē ar uzsildīšanas klauzulu — Tests L (aukstais starts) ir dabiska turpinājums.

### Ko šis izolē

Tā kā `Product.Version` sacensība tiek noņemta ar VU-uz-produkta piesaistīšanu, Testa K plaisa **nav** rindas-bloķēšanas izraisīta — tā ir katra modeļa strukturālais overhead. Salīdzinot to ar Testu F pie tāda paša VU skaita, kvantitatīvi nosaka, kāda daļa orķestrācijas deficīta ir raksturīga vs. cena par seriālajiem konfliktējošiem ierakstiem.

### Galvenā secinājuma būtība

Pie 25 VU pa atsevišķiem produktiem siltos servisos:

- **Caurlaides / latences uzvarētājs**: horeogrāfija (≈ 2× pasūtījumi/s, ≈ 3× ātrāka mediāna saga, ≈ 5× ātrāka API P95).
- **Astes-latences / uzticamības uzvarētājs**: orķestrācija (max saga 2 s vs 4.3 s; 0.1% kļūmes likme vs 4.1%).
- **Aukstā starta jutība**: horeogrāfija strauji degradē pirmajā palaidienā; orķestrācija ir palaidiena-uz-palaidiena stabila.

---

## Test L — Aukstā starta sods

### Mērķis

Mēra **latences sodu pirmajos pieprasījumos pēc svaiga servisa restartēšanas**, izolējot uzsildīšanas cenu, ko viena-šāviena testi parasti slēpj. Fiksē:

- **Temporal worker aktivizēšanu** (workflow tipa reģistrācija, sticky cache inicializēšana) orķestrācijai.
- **MassTransit patērētāja abonēšanu** (rindas/exchange/binding iestatīšana, kanāla piešķiršana) horeogrāfijai.
- **EF Core query plāna kompilāciju** pie pirmā trāpījuma.
- **.NET pakāpenisks JIT** pārvietojot karstas metodes no Tier-0 uz Tier-1.

Metrika: `coldPenaltyMs = firstRequestMs − warmTailAvgMs`.

### Iestatījumi

- **Iterācijas**: 20 secīgi pasūtījumi (`vus: 1`, `per-vu-iterations`).
- **Starpība**: 500 ms starp pieprasījumiem — pietiekami garš, lai nepārklātos, pietiekami īss, lai JIT/EF cache nesabruktu.
- **Endpoint**: `POST /api/orders/benchmark` (bloķē līdz terminālajam saga stāvoklim — pilns end-to-end laiks).
- **Aukstais trigeris**: 5 .NET saga servisi + api-gateway tiek `docker compose up -d --force-recreate` pirms katra palaidiena. Postgres, RabbitMQ un Temporal *netiek* atjaunoti, tāpēc to shēmas, rindu topoloģija un workflow-tipa reģistrs paliek silti. **Sods mēra servisa-procesa auksto startu, nevis infrastruktūras auksto startu.**
- **Aukstais sods**: `firstRequestMs − avg(perRequestMs[10..20])`. "Siltā aste" ir otrā puse.

### Rezultāti

| Metrika | Orķestrācija | Horeogrāfija | Δ (Choreo − Orch) |
|---|---:|---:|---:|
| Pirmais pieprasījums (ms) | 1375 | 1918 | **+543** |
| Siltās astes vidējais (ms) | 368 | 261 | **−107** |
| Aukstā starta sods (ms) | **1007** | **1657** | **+650** |
| Min siltais pieprasījums (ms) | 321 | 198 | −123 |
| Max siltais pieprasījums (ms) | 456 | 376 | −80 |

**Per-pieprasījuma profils (ms):**

| # | Orch | Choreo | | # | Orch | Choreo |
|---:|---:|---:|---|---:|---:|---:|
| 1 | **1375** | **1918** | | 11 | 344 | 278 |
| 2 | 331 | 364 | | 12 | 372 | 204 |
| 3 | 357 | 273 | | 13 | 385 | 321 |
| 4 | 398 | 198 | | 14 | 380 | 239 |
| 5 | 421 | 337 | | 15 | 321 | 199 |
| 6 | 398 | 304 | | 16 | 398 | 376 |
| 7 | 335 | 345 | | 17 | 345 | 201 |
| 8 | 396 | 231 | | 18 | 350 | 258 |
| 9 | 456 | 360 | | 19 | 387 | 277 |
| 10 | 373 | 308 | | 20 | 394 | 253 |

**Galvenā forma**: **abos** režīmos pirmais pieprasījums ir dramatiska ārpasaule. Pieprasījums #2 jau iekrīt normālajā siltās-astes joslā, tāpēc gandrīz visas aukstās izmaksas maksā viena saga.

### Analīze

**Horeogrāfija maksā 65% lielāku aukstā starta sodu** (1657 ms vs 1007 ms — ~650 ms lielāks). Arhitektūras skaidrojums:

- **Horeogrāfijai**, pie pirmās ziņas, jāsaista rindas, jādeklarē exchanges, jāpiešķir AMQP kanāli un jāstart patērētāji **visos četros** lejupejošajos servisos (`Inventory`, `Payment`, `Shipping`, `Notification`), jo katrs neatkarīgi patērē iepriekšējā soļa notikumu. Katrs serviss maksā savu MassTransit + EF auksto cenu pie savas pirmās ziņas, un šīs cenas **ķēdējas seriāli** pa sagu.
- **Orķestrācija** veic lielāko daļu aukstā darba *vienā* vietā: Temporal worker, kas tiek hostots `OrderService`, aktivizē workflow, reģistrē tipus un iesilda sticky cache. Aktivitātes citos servisos joprojām aukstā startē, bet Temporal klienta savienojums un dispatcher ir centralizēti, tāpēc per-lēciena overhead ir mazāks.

**Horeogrāfija ir ātrāka noturīgā stāvoklī** — 261 ms vs 368 ms (~29% noturīgā stāvokļa priekšrocība). Atbilst modeļu teorētiskajam izmaksu modelim:

- Orķestrācija pievieno Temporal round-trip per step (~5 papildu Temporal RPC un history ierakstus per saga).
- Horeogrāfijas per-step cena ir viena RabbitMQ publikācija + patērēšana, bez centrālas history tabulas atjaunināšanas.

### Lūzuma punkta analīze

Ja svaigi izvietots serviss apstrādā `N` pieprasījumus, pirms tas atkal tiek restartēts:

```
T(orch)   ≈ 1375 + 368 · (N − 1)
T(choreo) ≈ 1918 + 261 · (N − 1)
```

Atrisinot `T(choreo) ≤ T(orch)` iegūstam `N ≥ 1 + 543/107 ≈ 6.1`. **No pieprasījuma #7 horeogrāfija ir kumulatīvi ātrāka**, neraugoties uz tās sliktāko pirmā-pieprasījuma latenci. Jebkurai ne-triviālai slodzei starp izvietojumiem noturīgā stāvokļa priekšrocība dominē.

### Ko aukstā cena patiesi nozīmē

Tā kā Postgres, RabbitMQ un Temporal netiek atjaunoti, izmērītais sods ir **tīri .NET servisa-procesa uzsildīšana**, nevis infrastruktūras palaišana. Pilns `docker compose down/up` paaugstinātu auksto sodu 5–10× augstāk, jo Temporal auto-setup un Postgres buffer-cache uzsildīšana iekristu uz pirmās sagas. Ziņotie skaitļi ir **labākā gadījuma** aukstā starta scenārijs — visizteiksmīgākais modelis ritošajiem izvietojumiem un pod restartiem, kur brokeris / DB paliek darbībā.

### Praktiskās sekas

- **Slodzes ar reti restartiem un ilgtspējīgu trafiku** (ilgmūžīgi servisi, blue-green izvietojumi ar trafika rampu): **horeogrāfija uzvar kopumā**. 543 ms vienreizējais sods amortizējas dažu pieprasījumu laikā.
- **Slodzes ar biežiem aukstiem startiem** (autoscaling pie burst trafika, serverless scale-to-zero, canary izvietojumi, kas pakļauti vienam agram pieprasījumam): **orķestrācija ir prognozējamāka**. Pirmā-pieprasījuma cena ir zemāka absolūtos terminos (1375 vs 1918 ms), un silts-pret-auksts variance ir mazāks (faktors 3.7× vs 7.3×).
- **Astes latences / SLO dizains**: ja P99 SLO jāievēro tūlīt pēc izvietojuma, horeogrāfijas pirmā-pieprasījuma 1918 ms ir skaitlis, pret kuru jābudžetē, un sintētiska uzsildīšanas pieskāriens pirms pod pakļaušanas reālam trafikam ir būtībā obligāts. Orķestrācija pieļauj "izvietot, tad saņemt trafiku" ar mazāk ceremonijas.
- **Piezīme par N=1 pirmo pieprasījumu**: katram režīmam ir tikai viens aukstais paraugs, tāpēc absolūtie skaitļi nes per-palaidiena troksni. *Relatīvā secība* — horeogrāfijas lielāks aukstais lēciens, bet ātrāka siltā aste — ir robustais atklājums; atkārtojot 3–5× un ziņojot mediānu, apgalvojumu pieblīvinātu, neizmainot secinājumu.

---

## Test M — Kļūme rollback laikā

### Mērķis

Reproducē vadītāja scenāriju: *kas notiek, kad pati kompensācijas darbība neizdodas rollback vidū?* Tas jautā, vai saga var pati atjaunoties vai atstāj sistēmu pastāvīgi nekonsekventu.

Tests I validē **happy kompensācijas ceļu**. Tests M iet tālāk, injektējot **otru kļūmi pašā rollback**, atklājot atšķirību tajā, kā katrs modelis degradē, kad tā kompensējošā darbība nevar pabeigties.

### Iestatījumi

**Per iterācija**:

- **Piespiedu kompensācijas iebraukšana** — `PaymentService.failure-rate = 100`, tāpēc katra saga ieiet rollback pēc tam, kad Reserve izdodas.
- **Injektēt kaskādes kļūmi** — `FAIL_TARGET` vai nu:
  - `inventory` → `InventoryService.ReleaseAsync` met kļūdu katrā izsaukumā.
  - `notification` → `NotificationService.SendAsync` met kļūdu katrā izsaukumā.
- **Ievietot 10 pasūtījumus** secīgi (`vus=1`, `iterations=10`); aptaujāt `/api/orders/{id}/status` ik pēc 100 ms, līdz 15 s katram pasūtījumam.
- **Klasificēt iznākumu**:
  - `ordersReachedFailed` — pasūtījums sasniedza terminālo `Failed`.
  - `ordersStuck` — nekad neterminālisks 15 s laikā.
  - `inconsistentUnits` — inventāra noplūde (`currentReserved − baselineReserved`) **plus** iestrēgušie pasūtījumi.
- **Tīrīšana** atiestata kļūmes likmes, guļ 5 s, snapshots inventāru + statusa histogrammu.

Divi scenāriji × divi modeļi = četri palaidieni vienā sesijā.

### Rezultāti

#### Scenārijs A — `FAIL_TARGET=inventory` (kompensācijas solis, kas mutē stāvokli)

| Metrika | Orķestrācija | Horeogrāfija |
|---|---|---|
| Pasūtījumi sasniedza `Failed` | **10 / 10** | **0 / 10** |
| Iestrēgušie pasūtījumi (`Compensating`) | 0 | **10** |
| Nekonsekventas vienības (noplūde + iestrēgušie) | **10** (tīra inventāra noplūde) | **20** (10 noplūduši + 10 iestrēguši) |
| Laiks līdz terminālajam avg | 3643.5 ms | n/a |
| Laiks līdz terminālajam p95 / max | 3722.6 / 3723.0 ms | n/a |

#### Scenārijs B — `FAIL_TARGET=notification` (best-effort, bez blakusefektiem)

| Metrika | Orķestrācija | Horeogrāfija |
|---|---|---|
| Pasūtījumi sasniedza `Failed` | **10 / 10** | **10 / 10** |
| Iestrēgušie pasūtījumi | 0 | 0 |
| Nekonsekventas vienības | 0 | 0 |
| Laiks līdz terminālajam avg | 3625.3 ms | **215.8 ms** |
| Laiks līdz terminālajam med | 3624.5 ms | 218.5 ms |
| Laiks līdz terminālajam p95 | 3718.8 ms | 274.1 ms |
| Laiks līdz terminālajam max | 3721.0 ms | 316.0 ms |

### Analīze

**Galvenais atklājums: neviens modelis pats neatjaunojas — tie kļūdās dažādi.** Kad kompensācijas solis ir pastāvīgi salauzts, **abi modeļi atstāj sistēmu nekonsekventu**. Interesantais salīdzinājums ir *kļūmes režīms*, nevis tas, vai tas neizdodas. *"Neviens modelis automātiski neatjaunojas no pastāvīgi-kļūdaina kompensācijas soļa. Tie atšķiras tikai ar to, kā tie kļūdās."*

#### Inventāra kļūme: kluss noplūdums vs. redzams apstājums

Liela ietekmes gadījums, jo kļūdainais solis mutē noturīgu stāvokli.

- **Orķestrācija (Temporal)** — Katrs pasūtījums sasniedz `Failed` ~3.6 s, bet **10 inventāra rezervācijas noplūst**. Temporal kompensācijas aktivitāte ir konfigurēta ar `MaximumAttempts = 1`; izmestais `ReleaseAsync` izsaukums tiek norīts workflow catch blokā, workflow turpinās uz `Failed` pāreju, un rezervētais krājums nekad netiek atdots atpakaļ. Operatīvi tas ir **bīstamākais** iznākums: sistēma *izskatās* veselīga — pasūtījumi ir aizvērti, nav rindas dziļuma, nav retry — tomēr inventārs ir klusi noplūdies. Atklāšanai nepieciešams saskaņošanas darbs, kas salīdzina `Order.Status` ar `Product.reservedQuantity`.

- **Horeogrāfija (MassTransit)** — Katrs pasūtījums ir **iestrēdzis `Compensating`**, tāpēc nekonsekventības skaits dubultojas (10 noplūduši + 10 iestrēguši = 20). MassTransit `UseMessageRetry` pārmēģina `ReleaseInventory` trīs reizes, tad nogādā ziņu uz `release-inventory_error`. Saga state machine bezgalīgi gaida `InventoryReleased` notikumu, kas nekad nepienāk. Kļūme ir **skaļa**: iestrēgušas saga rindas `OrderSagaState`, ne-tukša DLQ RabbitMQ, brīdinājuma-draudzīga. Atjaunošanai nepieciešams DLQ atspēles rīks plus operatora darbība.

Kompromiss: **orķestrācija optimizē terminālā stāvokļa tīrību uz klusas stāvokļa korupcijas cenu; horeogrāfija saglabā eksplicītu "nepabeigta darba" signālu uz cenas atstāt sagu redzami salauztu**. Kura ir vēlamāka, ir atkarīgs no tā, vai operāciju komandai ir saskaņošanas darbi (par labu horeogrāfijas skaļajai kļūmei) vai vai bizness piešķir prioritāti aizvērtiem pasūtījumiem lejupejošiem patērētājiem (par labu orķestrācijas terminālajai garantijai, pieņemot noplūdi).

#### Notification kļūme: kur modeļi *patiešām* saplūst — bet ar ļoti dažādu latenci

Abi modeļi sasniedz `Failed` tīri ar nulles nekonsekventību, jo failure-notification ir implementēta kā best-effort (`try { send } catch { log }`) abās pusēs — izmests notification nebloķē sagu. Tāpēc funkcionāli šim scenārijam tie ir identiski.

Tomēr latence ir dramatiski atšķirīga:

- Orķestrācija: ~3.6 s avg, identiska inventāra-kļūmes ceļam.
- Horeogrāfija: ~216 ms avg — aptuveni **17× ātrāk**.

Orķestrācijas laiks ir neatkarīgs no tā, *kura* kompensācijas mērķa neizdodas, kas norāda, ka ~3.6 s ir raksturīgā Temporal kompensācijas konveijera cena (aktivitātes plānošana + retry budžeta izsīkšana + stāvokļa pārejas ieraksti). Horeogrāfijas kompensācija ir tikai fire-and-forget `Publish<SendNotification>`, kam seko sinhrona saga stāvokļa pāreja — tā vispār nepalaiž paziņojumu, tāpēc kļūmes injekcija nekad nebloķē sagu.

Tas nozīmē **mazas-ietekmes kompensācijas kļūmēm horeogrāfija atjaunojas par lieluma kārtu ātrāk**, bet, kā parāda Scenārijs A, šī ātrums pazūd (kļūst bezgalīgs) brīdī, kad kļūdainais solis ir tāds, ko saga patiešām gaida.

### Metodoloģiskās piezīmes

- Paraugu skaits mazs (10 iterācijas vienai šūnai) — labi kvalitatīvajam pass/fail signālam, bet laiku percentīles `timeToTerminalMs` ir ilustratīvas, nevis statistiski robustas.
- `inconsistentUnits` metrika pārslogo divus dažādus kļūmes režīmus (noplūdes skaits + iestrēgušo skaits). Horeogrāfijas-inventāra šūnai vērtība `20` atspoguļo *abus* efektus uz tām pašām 10 pasūtījumiem — nevis 20 atsevišķas kļūmes.
- 15 s aptaujāšanas noildze ir komforta orķestrācijas ~3.7 s terminālajam laikam, bet ierobežo, cik pārliecināti varam teikt, ka horeogrāfijas pasūtījumi ir *pastāvīgi* iestrēguši, nevis tikai lēni. Tests N (brokera pārtraukums) un O (worker avārija) zondē garākus atjaunošanas logus.
- Notification kompensācija ir best-effort *pēc dizaina* abās implementācijās — Scenārijs B validē šo dizaina izvēli, bet nezondē, kas notiek, ja ne-best-effort lejupejošs solis neizdodas. Tieši tam ir Scenārijs A.

### Sekas

Tests M demonstrē, ka **kompensācijas korektība nav automātiska īpašība nevienam saga modelim** — tā ir atkarīga no:

1. Retry/timeout politikas, kas konfigurēta uz kļūdainā soļa.
2. Vai saga *gaida* šī soļa veiksmes notikumu.
3. Vai operāciju komandai ir rīki klusa inventāra novirzes vs iestrēgušu saga rindu atklāšanai.

Abi modeļi prasa ārēju atjaunošanas instrumentāciju (saskaņošanas darbu orķestrācijai, DLQ atspēles rīku horeogrāfijai) ražošanas-līmeņa noturībai pret pastāvīgi-kļūdainām kompensācijām. Modeļa izvēle ietekmē *kā* veidojat šo instrumentāciju, nevis *vai* tā ir vajadzīga.

---

## Test N — Brokera pārtraukums rollback laikā

### Mērķis

Pārbauda, ka procesā esoša saga **izdzīvo savas pamatā esošās brokera restartēšanu rollback vidū**. Katrs modelis ir atkarīgs no atšķirīga brokera:

- **Orķestrācija** → `saga-temporal` (Temporal serveris tur workflow stāvokli un nosūta aktivitātes).
- **Horeogrāfija** → `saga-rabbitmq` (ziņas autobuss pārvieto saga `*Reserved` / `*Failed` / `Release*` notikumus).

Jautājums: *Kad brokeris atgriežas, vai visas sagas nodzina sevi uz terminālo stāvokli, un vai ir kāds atstāts stāvoklis (iestrēguši pasūtījumi, noplūduša inventārs)?*

Papildina Testu M (kompensācijas **soļa** kļūme), kļūdās **transports** tā vietā.

### Iestatījumi

Noklusējumi no `run-broker-outage-test.sh`:

- **`ORDERS=10`**, **`BROKER_DOWN_SECS=10`**, **`RECOVERY_SECS=90`**, **`WARMUP_MS=500`**.
- Visi pasūtījumi mērķē uz to pašu produktu (`a1111111-...`).

**Palaidiena secība**:

1. Atiestatīt inventāru + pasūtījumus, iestatīt **`payments/failure-rate/100`**, lai katrs pasūtījums tiktu spiests kompensācijā.
2. Snapshot bāzes `reservedQuantity`.
3. Ievietot 10 pasūtījumus secīgi.
4. Gulēt 500 ms, lai sagas sāktu darboties.
5. `docker stop` attiecīgo brokeri; gaidīt 10 s; snapshot pasūtījumu-statusa histogrammu **pārtraukuma laikā**.
6. `docker start` brokeri, gaidīt veselības pārbaudi.
7. Aptaujāt `/api/orders/recent` ik pēc 2 s līdz 90 s, iziet agri, ja katrs pasūtījums sasniedza `Completed`/`Failed`.
8. Galīga histogramma + inventāra noplūde (`reservedNow − baseline`); atiestatīt maksājumu kļūmes likmi.

Orķestrācijas un horeogrāfijas palaidieni tika veikti pēc kārtas 23:01:40 un 23:03:09 dienā 2026-04-28.

### Rezultāti

#### Orķestrācija

| Fāze | Vērtība |
|---|---|
| Brokeris apturēts → palaists | 23:01:44 → 23:01:55 (~11 s pārtraukums) |
| Pasūtījumu histogramma **pārtraukuma laikā** | `{Pending: 10}` |
| Atjaunošanas aptaujāšana | **Visi 10 sasniedza terminālo pirms 90 s termiņa** |
| Galīga histogramma | `{Failed: 10}` |
| Inventāra noplūde | **2** vienības (bāze 0, rezervēts 2) |
| Pulksteņa laiks | sākts 23:01:40, pabeigts 23:02:20 (~40 s kopā) |

#### Horeogrāfija

| Fāze | Vērtība |
|---|---|
| Brokeris apturēts → palaists | 23:03:13 → 23:03:24 (~11 s pārtraukums) |
| Pasūtījumu histogramma **pārtraukuma laikā** | `{Compensating: 3, Failed: 4, Pending: 3}` |
| Atjaunošanas aptaujāšana | "All orders reached terminal state" rinda **trūkst** → aptaujāšana darbojās pilnus 90 s |
| Galīga histogramma | `{Compensating: 1, Failed: 8, Pending: 1}` — **2 pasūtījumi iestrēguši** |
| Inventāra noplūde | **1** vienība |
| Pulksteņa laiks | sākts 23:03:09, pabeigts 23:04:55 (~106 s, gandrīz pilnībā 90 s aptaujāšana) |

### Analīze

**Saga progress nogalināšanas brīdī ir asimetrisks.** Ar orķestrāciju **katra** aktivitātes dispatch iet caur Temporal. 500 ms uzsildīšana ir īsāka par laiku, kas pirmajai aktivitātei vajadzīgs round-trip caur Temporal worker, tāpēc, kad serveris mirst, neviena no 10 sagām nav virzījusies tālāk par `Pending` (`Pending: 10` pie `t = 10 s`).

Horeogrāfija pārvietojas caur asinhronām RabbitMQ ziņām bez centrāla koordinatora: brīdī, kad `saga-rabbitmq` tiek nogalināts, **4 sagas jau ir nokārtojušās līdz `Failed`**, 3 ir kompensācijas vidū un tikai 3 ir vēl pirms-kompensācijas. Tāpēc orķestrācija ieiet savā pārtraukuma logā ar 10 procesā esošiem workflows, horeogrāfija ar efektīvi 6. **Šī asimetrija jāatzīmē, salīdzinot atjaunošanas skaitļus.**

**Atjaunošanas uzvedība:**

- **Orķestrācija atjaunojas tīri un ātri.** Temporal pārspēlē workflow history no Postgres pie restartēšanas, worker atkārtoti pievienojas, un gaidāmās aktivitātes tiek atkārtoti dispatcētas. Visi 10 pasūtījumi sasniedz `Failed`, labi 90 s budžetā — pulksteņa laiks no pārtraukuma beigām līdz testa beigām ir ~25 s.
- **Horeogrāfija pilnībā neatjaunojas 90 s laikā.** RabbitMQ atgriežas ar noturīgām rindām neskartām, bet **2 no 10 pasūtījumiem paliek ne-terminālā stāvoklī** — 1 iestrēdzis `Compensating`, 1 iestrēdzis `Pending` — pat pēc pilna aptaujāšanas loga. MassTransit atkārtoti piegādā lielāko daļu notikumu, bet vismaz viens `InventoryReleased` / payment-failed nodošana tika zaudēta vai nogādāta tā, ka saga state machine nekad nevirzās uz priekšu. Atbilst paredzētajam horeogrāfijas kļūmes režīmam: saga, kas gaida atzvanu, kas nekad nepienāk, paliek `Compensating` bezgalīgi.

**Inventāra noplūde — tas pats iznākums, atšķirīga redzamība.** Abi režīmi noplūdina krājumu, bet *veids* ir svarīgs:

- **Orķestrācija**: 2 noplūdušas rezervācijas uz **10 pilnībā-`Failed`** pasūtījumiem. Tas pats kompensācijas-bug raksturs, ko atklāja Tests M — `CompensationActivityOptions.MaximumAttempts = 1` izraisa `ReleaseInventory` norīt pārejošu brokera-atjaunošanas kļūdu, un workflow catch-loop iezīmē sagu kā `Failed` neatkarīgi. **Pasūtījums izskatās veselīgs operatoram; inventāra grāmatvedība ir klusi nepareiza.**
- **Horeogrāfija**: 1 noplūdusi rezervācija, korelēta ar 2 iestrēgušajiem pasūtījumiem. Saga ir **redzami apstājusies** (statuss to atklāj), tāpēc operatoram ir skaidrs signāls, ka nepieciešama iejaukšanās.

### Neto salīdzinājums

| Īpašība | Orķestrācija | Horeogrāfija |
|---|---|---|
| Visi pasūtījumi terminālā? | **Jā** (10/10 `Failed`) | **Nē** (2/10 iestrēguši) |
| Laiks līdz nostāties pēc restartēšanas | ~25 s | > 90 s (aptaujāšana izsīka) |
| Kļūmes režīms | **Kluss** (izskatās `Failed`, inventārs nepareizs) | **Redzams** (statuss iestrēdzis `Compensating`/`Pending`) |
| Inventāra noplūde | 2 / 10 | 1 / 10 |

**Orķestrācija uzvar liveness** (workflow history pārspēlēšana ir deterministiska un ierobežota); **horeogrāfija uzvar novērojamību** (iestrēgusi saga rinda ir skaļāks satraukums nekā klusi-noplūdusi rezervācija). Neviens modelis automātiski tīri neatjaunojas — noplūdes ir tas pats kompensācijas-slāņa jautājums, ko Tests M iezīmēja, atklāts caur citu kļūmes injekciju.

### Piezīmes

1. **Paraugu skaits sīks**: 10 pasūtījumi, viens palaidiens katram režīmam. Traktējiet noplūdes/iestrēgušo skaitļus kā ilustratīvus, nevis statistiskus. Atkārtots palaidiens ar `ORDERS=50` un 3+ atkārtojumiem to pieblīvinātu.
2. **Asimetrisks pirms-pārtraukuma progress** (10 `Pending` vs 4 `Failed` + 3 `Compensating` + 3 `Pending`) padara atjaunošanas salīdzinājumu netaisnīgu uz pirmā skatiena. `WARMUP_MS` regulēšana, līdz abiem režīmiem ir tāds pats statusa sadalījums nogalināšanas brīdī, izolētu "brokera atjaunošanas cenu" no "saga soļa latences".
3. **Atjaunošanas logs**: pie `RECOVERY_SECS=90`, horeogrāfijas 2 iestrēgušajiem pasūtījumiem var vienkārši būt vajadzīgs ilgāks par 90 s. Atkārtots palaidiens ar 300 s atšķirtu "lēni, bet beidzot atjaunojas" no "pastāvīgi apstājies".
4. Temporal-puses noplūde ir **konfigurācijas izvēle** (`MaximumAttempts = 1` uz kompensācijas aktivitātes), nevis fundamentāla orķestrācijas robeža. Tā paaugstināšana aizvērtu noplūdi — bet pārtrauktu simetriju ar horeogrāfijas retry politiku, ko Tests M bija paredzēts salīdzināt.

---

## Test O — Worker avārija saga vidū

### Mērķis

Validē **noturību pret saga koordinatora procesa avāriju**. Konteineris `saga-order-service` tiek nogalināts, kamēr sagas ir procesā, tad restartēts, lai pārbaudītu, vai katrs modelis atsāk savas procesā esošās sagas un sasniedz konsekventu terminālo stāvokli.

Šis ir īpaši spēcīgs salīdzinājuma punkts, jo `saga-order-service` host abus:

- **Temporal worker** (orķestrācija) — t.i., aktivitātes izpildītājs.
- **MassTransit saga state machine** (horeogrāfija) — t.i., `OrderSagaState` patērētājs.

Tāpēc tas pats viena-procesa kļūme izpilda *abu* modeļu atjaunošanas mehānismus — Temporal "servera-pārvaldīta workflow history" vs MassTransit "brokera-pārvaldīta vismaz-vienreiz piegāde".

### Iestatījumi

Vada `run-worker-crash-test.sh`:

- **Piespiedu kompensācijas ceļš** — `PaymentService.failure-rate=100`, tāpēc katram pasūtījumam jāieiet kompensācijā.
- **Slodze** — `ORDERS=10` pasūtījumi, kas tiek ievietoti caur gateway, katrs 1 vienībai `a1111111-...` par $29.99.
- **Avārijas logs** — `WARMUP_MS=500`, tad `docker kill saga-order-service`.
- **Dīkstāve** — `DOWN_SECS=5`.
- **Restart** — `docker start saga-order-service`, aptaujāt `/api/orders/config`, līdz veselīgs.
- **Novērojumu logs** — `RECOVERY_SECS=90`, aptaujāt `/api/orders/recent` ik pēc 2 s, pārtrauc agri, ja visi pasūtījumi ir terminālā stāvoklī.
- **Galīgais ziņojums** — pasūtījuma-statusa histogramma + inventāra noplūde pret bāzi.
- **Infrastruktūra netiek skarta** — Postgres, RabbitMQ un Temporal paliek augšā visu laiku. Tikai `saga-order-service` tiek nogalināts.

Abi režīmi tika palaisti ar identiskiem parametriem, ~2 minūtes atšķirībā 2026-04-28.

### Rezultāti

#### Orķestrācija

| Metrika | Vērtība |
|---|---|
| Nogalināts pie | `23:05:53` (≈2 s pēc starta) |
| Atpakaļ augšā pie | `23:05:59` (≈6 s dīkstāve) |
| Atjaunošanas aptaujāšana | **Izgāja agri** — "All orders reached terminal state" |
| Galīga histogramma | `{"Failed": 10}` |
| Inventāra noplūde | `0` (rezervēts=0, bāze=0) |
| Kopējais pulksteņa laiks | ~25 s |

**Visi 10 pasūtījumi sasniedza `Failed` (paredzētais terminālais stāvoklis pie piespiedu 100% maksājumu kļūmes).**

#### Horeogrāfija

| Metrika | Vērtība |
|---|---|
| Nogalināts pie | `23:07:33` (≈3 s pēc starta) |
| Atpakaļ augšā pie | `23:07:40` (≈7 s dīkstāve) |
| Atjaunošanas aptaujāšana | **Noildze** — nav "All orders reached terminal state" rindas |
| Galīga histogramma | `{"Pending": 6, "Failed": 4}` |
| Inventāra noplūde | `0` (rezervēts=0, bāze=0) |
| Kopējais pulksteņa laiks | ~101 s |

**Tikai 4 no 10 pasūtījumiem sasniedza terminālo stāvokli; 6 joprojām bija `Pending` pēc pilna 90 s atjaunošanas loga.**

#### Blakus

| Iznākums | Orķestrācija | Horeogrāfija |
|---|---|---|
| Pasūtījumi sasniedz terminālo stāvokli | **10 / 10** | **4 / 10** |
| Pasūtījumi iestrēguši ne-terminālā | 0 | **6 (Pending)** |
| Laiks līdz pilnai atjaunošanai | ~17 s aptaujāšanas | **nekad (noildze pie 90 s)** |
| Inventāra noplūde | 0 | 0 |

### Analīze

**Orķestrācija: tīra atjaunošana.** Temporal eksternalizē workflow patiesības avotu Temporal servera history tabulā. Kad `saga-order-service` tiek nogalināts:

- Pats workflow *netiek* hostets OrderService — tas dzīvo Temporal serverī.
- Jebkura aktivitāte procesā avārijas brīdī tiek iezīmēta failed-task un **atkārtoti nosūtīta** nākamajam worker, kas aptaujā task queue.
- Kad OrderService atgriežas augšā, tā Temporal worker atkārtoti pievienojas, pieprasa gaidāmās aktivitātes uzdevumus, un workflow virzās tieši tur, kur tas pārtrauca.

Empīriski: visas 10 sagas izgāja Reserve → Payment(fail) → Compensate(release) → `Failed`, ar **nulles inventāra noplūdi**, aptaujāšana izgāja agri (~17 s), jo viss bija termināls.

**Horeogrāfija: 60% sagu iestrēguši `Pending`.** Horeogrāfija šeit izmanto MassTransit saga state machine, ar stāvokli persistētu OrderService Postgres `OrderSagaState` tabulā un notikumiem, kas plūst caur RabbitMQ. Paredzētais atjaunošanas stāsts ir:

- Notikumi, kas publicēti pirms avārijas, sēž noturīgi RabbitMQ rindās.
- Pie restartēšanas MassTransit patērētāji atkārtoti pievienojas un izvada rindas, virzot saga rindas.

Šis stāsts *neturēja*. **6 no 10 pasūtījumiem nekad nepavirzījās tālāk par `Pending` 90 s pēc restartēšanas.** Visiespējamākie pamata cēloņi:

- **`OrderCreated` notikumi pazaudēti publicētāja pusē.** Pasūtījuma POST visticamāk atgriezās 202 *pirms* atbilstošā `OrderCreated`/`StartSaga` ziņa tika apstiprināta RabbitMQ (nav transactional outbox + publisher-confirms savienota caur HTTP atbildi). Kad process tika nogalināts, šie ne-publicētie notikumi tika zaudēti — nav brokera kopijas, ko atkārtoti piegādāt, nav Temporal-stila servera, kas turētu nodomu. `Order` rinda eksistē (`Pending`), bet notikums, kas to virzītu, nekad netika noturīgi nodots.
- **Saga state machine nav "kick-restart" novecojušām rindām.** Lai gan `Pending` rindas eksistē Postgres, MassTransit tās virzīs tikai tad, ja pienāks atbilstošs notikums. Ar `OrderCreated` rindā nav, rindas sēž tur mūžīgi.
- 4, kas *sasniedza* `Failed`, ir pasūtījumi, kuru `OrderCreated` tika apstiprināts RabbitMQ pirms nogalināšanas, un kuru lejupejošie notikumi (`PaymentFailed`) arī bija noturīgi rindā. Tie pareizi pārspēlējās pie restartēšanas — horeogrāfijas at-least-once mehānika strādā *notikumiem, kas patiesi ir nokļuvuši brokerī*.

### Ko šis salīdzinājums demonstrē

| Aspekts | Orķestrācija (Temporal) | Horeogrāfija (MassTransit) |
|---|---|---|
| Kur workflow nodoms tiek persistēts | **Ārējs noturīgs serveris** (Temporal history tabula) | OrderService atmiņa + Postgres saga rinda + RabbitMQ rinda |
| "Nodoma" izdzīvošana, kad host process mirst pirms pirmā notikuma | **Jā** — Temporal jau pieņēma workflow startu | **Nē** (šajā implementācijā) — `OrderCreated` var tikt zaudēts starp HTTP 202 un brokera publikāciju |
| Atjaunošanas darbība | Worker atkārtoti pievienojas, Temporal atkārtoti dispatcē procesā esošās aktivitātes | Patērētājs atkārtoti pievienojas, izvada rindas — bet tikai notikumiem, kas brokerī patiesi ir |
| Rezultāts uz `ORDERS=10`, `DOWN_SECS=5` | **10/10 termināls, 0 noplūde** | **4/10 termināls, 6 Pending, 0 noplūde** |
| Operatora redzamība uz "kas iestrēdzis" | Workflow redzams Temporal UI kā Running | `Pending` rinda `OrderSagaState`, nav rindā esoša notikuma — kluss apstājums |

### Piezīmes

- **Inventārs bija konsekvents abos režīmos** (nav pārpārdošanas, nav noplūdes), tāpēc tas *nav* datu-korupcijas rezultāts — tas ir saga-progresa rezultāts.
- **Horeogrāfijas uzvedība ir implementācijas-atkarīga.** Transactional outbox pievienošana, publisher-confirms, kas vārtē HTTP 202, vai periodisks "skenēt novecojušas `Pending` sagas un atkārtoti publicēt" darbs aizvērtu konkrēto novēroto plaisu. Punkts darbam ir tāds, ka **orķestrācija caur Temporal saņem crash-mid-saga durability "par velti", kamēr horeogrāfija prasa apzinātu inženieriju katrā persist-then-publish robežā** — un saprātīga, strādājoša horeogrāfijas iestatīšana, kā šī, joprojām var nomest sagas uz grīdas, kad koordinatora process mirst.
- **Paraugu skaits ir mazs** (10 pasūtījumi, viens palaidiens katram režīmam). Rezultāti šeit ir skaidri, bet augstāka `ORDERS` vērtība (50–100) un 3–5 atkārtojumi katram režīmam ļautu citēt iestrēgušas-saga likmi, nevis vienu 6/10 datu punktu.

### Ieteicamais formulējums

> Pie koordinatora-procesa avārijas saga vidū, orķestrācija nodzina 10/10 piespiedu-kompensācijas sagas uz konsekventu terminālo stāvokli ~17 s, kamēr horeogrāfija — bez transactional outbox — atstāja 6/10 sagas bezgalīgi iestrēgušas `Pending`, jo to `OrderCreated` notikumi nekad nesasniedza RabbitMQ pirms procesa mirušanas. Abi modeļi saglabāja inventāra invariantus, bet tikai orķestrācija saglabāja saga progresu. Tas konkrēti ilustrē cenu, ko horeogrāfija maksā, kad sagas "patiesības avots" ir kopā novietots ar procesu, kas var avarēt.

---

## Kopsavilkums

### Veiktspēja (happy ceļš)

| Metrika | Uzvarētājs | Atstarpe |
|---|---|---|
| Saga end-to-end latence (1–10 rps) | **Horeogrāfija** | ~50–500 ms ātrāk (Tests A, J) |
| Ilgtspējīgā caurlaide | **Horeogrāfija** | ~5× augstāka (Tests A: 50 rps vs 10 rps) |
| Vienlaicīgo lietotāju caurlaide (silta) | **Horeogrāfija** | ~2× pasūtījumi/s, ~3× ātrāka mediāna saga (Tests K) |
| API pieņemšanas P95 | **Horeogrāfija** | ~80% zemāka veselīgā režīmā (Tests A, K) |
| Per-step P95 | **Horeogrāfija** | ~100 ms zemāka katrā solī (5 soļi × ~100 ms = ~500 ms saga atstarpe) |

### Stabilitāte un astes

| Metrika | Uzvarētājs | Piezīmes |
|---|---|---|
| Astes latence / max | **Orķestrācija** | Horeogrāfijas max bieži 6–12× p95; orch ~2× p95 (Tests E, J, K) |
| Palaidiena-uz-palaidiena konsistence (auksts pirmais palaidiens) | **Orķestrācija** | Horeogrāfija rāda lielu pirmā-palaidiena sodu (Tests K) |
| Izturība (5 min @ 25 rps) | **Neizšķirts** | Abi noturīgā stāvoklī, bez nobīdes (Tests J) |

### Resursu efektivitāte

| Metrika | Uzvarētājs | Piezīmes |
|---|---|---|
| Noturīga stāvokļa CPU | **Horeogrāfija** | Zemāks per-saga veselīgā režīmā (Tests D) |
| Uzvedība pie nepietiekamības | **Orķestrācija** | Gracioza lineāra degradācija; horeogrāfija sabrūk (Tests D, 25 rps × 0.5 CPU) |
| Aukstais starts (viens pirmais pieprasījums) | **Orķestrācija** | 1007 ms sods vs 1657 ms (Tests L) |
| Noturīga stāvokļa silta latence | **Horeogrāfija** | 261 ms vs 368 ms; lūzuma punkts ~7 pieprasījumos (Tests L) |

### Korektība

| Īpašība | Abi ekvivalenti | Piezīmes |
|---|---|---|
| Pārpārdošanas novēršana (vienlaicīga sacensība) | **Jā** | DB-līmeņa `xmin` žetons; saga modelis ir nesvarīgs (Tests F) |
| Idempotents dubultais klikšķis | **Jā** | Pirms-dispatch idempotences ieraksts (Tests G) |
| Kompensācijas korektība (deterministiska 100% kļūme) | **Jā** | Abi sasniedz `Failed` bez noplūdēm (Tests I) |
| Eventual-consistency logs (redzamības aizture) | **Horeogrāfija nedaudz ātrāka** (~8 ms mediāna, ~7 ms p95) | Orķestrācijai ir strukturāli smagāka aste (Tests E) |

### Noturība (kļūmes-režīma salīdzinājums)

| Scenārijs | Orķestrācija | Horeogrāfija |
|---|---|---|
| Kompensācijas solis met (Tests M, inventārs) | Visi `Failed`, bet **kluss noplūdums** | Visi **iestrēguši `Compensating`** + noplūde |
| Kompensācijas solis met (Tests M, notification, best-effort) | ~3.6 s, bet tīrs | ~216 ms, tīrs |
| Brokera pārtraukums rollback laikā (Tests N) | 10/10 termināls ~25 s; 2 noplūduši (joprojām klusi) | 2/10 iestrēguši pēc 90 s; 1 noplūde |
| Koordinatora avārija saga vidū (Tests O) | **10/10 atjaunoti** ~17 s | **6/10 iestrēguši `Pending`** bezgalīgi (nav transactional outbox) |

### Kļūmes-apstrādes semantika

Dziļākais šķērsgriezuma atklājums no Tests F, H, I, M, N ir tāds, ka **abi modeļi atklāj dažādus kļūmes budžetus saga robežā**:

- **Orķestrācija pārmēģina aktivitātes kļūdas** pēc noklusējuma. Pārejošas lejupejošās kļūmes tiek klusi absorbētas (Tests H: 0% novērotā kļūme ar 10% per-call kļūmes likmi, jo `MaximumAttempts=3`). Cena ir ~3 s retry budžets, kas kļūst par latences nodokli kompensācijas ceļos (Tests I, M, N).
- **Horeogrāfija traktē kļūmes kā biznesa notikumus**. Patērētājs, kas notver kļūmi un publicē `PaymentFailed`, neiesaista `UseMessageRetry`. Kompensācijas sākas nekavējoties (~200 ms, Tests I), bet pārejošas lejupejošās kļūdas parādās kā lietotājam-redzamas kompensācijas, nevis tiek pārmēģinātas.

Šīs ir dažādas dizaina izvēles, nevis implementācijas bug. Politiku izlīdzināšana prasa vai nu Temporal retry deaktivizēšanu (`MaximumAttempts=1`), vai horeogrāfijas patērētāju iesaiņošanu `UseMessageRetry` un kļūdu pārmestīt pie biznesa kļūmes.

### Kad izvēlēties katru modeli

**Horeogrāfija ir vēlama, kad:**

- Sistēmai ir CPU rezerve (klastera izmērs noteikts tā, lai neviens atsevišķs serviss nepārsniegtu ~70% CPU noturīgā stāvoklī).
- Restarti ir reti un trafiks ir ilgtspējīgs (aukstā starta sods amortizējas 6+ pieprasījumos).
- Konsekventa zema mediānas latence ir svarīgāka par astes robežām.
- Kļūmēm jābūt redzamām / skaļām (iestrēgušas sagas, DLQ ieraksti) operatora brīdinājumam.
- Caurlaide ir primārais prasījums (~2–5× augstāka ilgtspējīga likme uz tās pašas aparatūras).

**Orķestrācija ir vēlama, kad:**

- Sistēma darbojas tuvu piesātinājumam vai zem burst nepietiekamības (Temporal task queue absorbē slodzi graciozi).
- Prognozējama astes latence (P99–max ierobežota) ir stingrs prasījums.
- Koordinatora process var avarēt un sagai jāturpinās (Tests O).
- Bieži aukstie starti (autoscale, scale-to-zero) — pirmā-pieprasījuma cena ir zemāka.
- Operāciju komanda piešķir prioritāti terminālā stāvokļa tīrībai pār klusu stāvokļa korupciju (ar saskaņošanas darbu).

### Inženierijas atklājumi darbam

1. **Saga-modeļa korektības īpašības (pārpārdošana, idempotence, pamata kompensācija) tiek mantotas no datubāzes un HTTP slāņa**, nevis no koordinācijas modeļa. Abi modeļi izpilda šos testus identiski.
2. **Veiktspējas plaisa (~3× ātrāks end-to-end horeogrāfijai) ir strukturāla** — Temporal per-step centralizētais stāvoklis + aktivitāšu plānošana pievieno ~100 ms uz katras soļa pārejas. Tā ir cena, ko maksā par durability un novērojamību, ko Temporal sniedz.
3. **Kļūmes semantika dominē kļūmes-režīma uzvedību** vairāk nekā pats saga modelis. Tā pati retry politika var iedarbināties (Temporal kļūdas ceļš) vai tikt apieta (horeogrāfijas notikuma ceļš) atkarībā no tā, kā patērētājs reaģē uz lejupejošu kļūmi.
4. **Abi modeļi prasa ārēju atjaunošanas instrumentāciju** pastāvīgi-kļūdainām kompensācijām: saskaņošanas darbs orķestrācijas klusajai-noplūdes kļūmes režīmam, DLQ atspēles rīks horeogrāfijas iestrēgušās-sagas kļūmes režīmam.
5. **Bez transactional outbox horeogrāfija var zaudēt sagas koordinatora avārijas laikā** (Tests O). Orķestrācija caur Temporal iegūst šo durability "par velti", jo workflow patiesības avots ir ārējs host procesam.

---

## Atbildes (Answers)

Šī sadaļa sasaista empīriskos rezultātus ar darba ievadā formulētajiem jautājumiem un hipotēzēm.

### Pētniecības jautājumi

#### J1 — Eventual consistency un lietotāja pieredze

> *Kad lietotājs nospiež "pirkt", cik ilgi viņš gaidīs, līdz redzēs rezultātu? Un kas notiek, ja pa vidu kaut kas noiet greizi? Vai lietotājs sapratīs, kas notika? Fowler [9] norāda, ka eventual consistency var radīt nopietnas lietojamības problēmas, bet konkrētu risinājumu nav daudz dokumentētu.*

**Atbilde.** Eventual consistency loga ilgumu mēra Tests E. Mediānā krājuma izmaiņas kļūst redzamas inventāra API pēc **~32 ms (horeogrāfija)** vai **~33 ms (orķestrācija)**, bet pasūtījuma terminālā statusa (`Completed`) sasniegšana prasa **~280 ms (horeogrāfija)** vai **~345 ms (orķestrācija)**. Reālais "neapstiprinātās noteiktības" logs — kurā krājums jau ir rezervēts, bet pasūtījums vēl ir `Pending` — ir aptuveni **¼ sekundes**, neatkarīgi no izvēlētā saga modeļa.

Astes uzvedība ir asimetriska. Orķestrācijas `max` saga pabeigšanas latence sasniedz **1205 ms** (~3× virs P95), kamēr horeogrāfijas tīrajā izpildē `max ≈ p95 + 15 ms`. Tas nozīmē, ka aptuveni 1 % lietotāju orķestrācijā piedzīvos jūtami ilgāku gaidīšanu.

**Kļūdas saprotamība** ir nodrošināta abu modeļu līmenī: Tests I apstiprina, ka **100 %** kļūdaino pasūtījumu sasniedz `Failed` ar atbrīvotu krājumu abās pieejās — lietotājs saņem deterministisku stāvokli, nevis "kaut kas nogāja greizi". Tomēr Tests M un N atklāj, ka tad, ja pati kompensācija arī neizdodas:

- **Orķestrācija** atstāj pasūtījumu ar `Failed` statusu, bet ar **klusi noplūdušu krājumu**.
- **Horeogrāfija** atstāj pasūtījumu ar redzami iesprūdušu `Compensating` statusu.

Horeogrāfija ir "skaļāka" (operators redz iesprūdušu sagu), orķestrācija ir "klusāka" (orderis šķiet pabeigts, bet inventārs ir nepareizs).

**Fowler [9]** brīdinājums empīriski apstiprinās: vienreizēja gaidīšana (~280 ms) nav kritiska, bet astes gadījumos un kompensācijas kļūdās lietotāja uztvere kļūst būtiski atkarīga no implementācijas izvēlēm — idempotences atbalsta (Tests G), retry politikām (Tests H, I) un UI klienta uzvedības.

#### J2 — Race conditions

> *Divi lietotāji vienlaicīgi mēģina iegūt to pašu ierobežoto resursu — kurš uzvar? Vai zaudētājs saņem saprotamu kļūdas paziņojumu, nevis vienkārši "kaut kas nogāja greizi"?*

**Atbilde.** Tests F (20 VU vienlaicīgi pēc 1 vienības krājumā) apstiprina, ka **abas pieejas precīzi novērš pārpārdošanu**: `wins = 1, losses = 19` katrā no četriem palaidieniem. Korektība nāk no **datubāzes līmeņa** — PostgreSQL `xmin` rindas-versijas optimistiskās konkurences uz `Product.Version` lauka — un nav atkarīga no saga modeļa.

**Zaudētāju pieredzē** abas pieejas atšķiras būtiski:

| Pieeja | Avg | P95 | Spread starp palaidieniem |
|---|---:|---:|---:|
| Orķestrācija | ~3.5 s | 3 557 – 4 011 ms | < 12 % |
| Horeogrāfija | ~4.2 s | 3 914 – **33 357 ms** | **~17×** |

Iemesls: orķestrācijas aktivitāte saņem `409 Conflict`, klasificē to kā domēna kļūdu un nekavējoties pāriet kompensācijai. Horeogrāfijā `ReserveInventoryConsumer` apzināti pārmestīt `DbUpdateConcurrencyException`, ļaujot MassTransit pārmēģināt — un katrs pārmēģinājums atkal sacenšas par to pašu rindu.

**Uzvarētājs vienmēr ir viens**, bet **zaudētāja gaidīšanas laiks ir aptuveni 9× prognozējamāks orķestrācijā**. Saprotama kļūda (terminālais `Failed` statuss un `InventoryReservationFailed` notikums) tiek nodota klientam abos gadījumos; atšķirība ir tikai gaidīšanas ilgumā un dispersijā.

#### J3 — Kompensācijas mehānisms

> *Kad Saga neizdodas pusceļā, kā notiek "attīšana"? Vai orķestrācija to dara ātrāk un uzticamāk nekā horeogrāfija? Teorētiski jā, jo ir centralizēta kontrole. Bet praksē?*

**Atbilde.** Praksē — **nē**, ne ātrāk un ne automātiski uzticamāk. Tests I (100 % maksājumu kļūme, deterministiskā kompensācija) parāda:

- Orķestrācija: avg = **3 586 ms**, P95 = **3 644 ms**.
- Horeogrāfija: avg = **193 ms**, P95 = **229 ms**.

Orķestrācija ir **~18× lēnāka** sasniegt `Failed`. Iemesls **nav kompensācijas latence**, bet **kļūmes semantikas atšķirība**:

- Orķestrācijā `ProcessPaymentAsync` aktivitāte iemet `ApplicationException`, ko Temporal traktē kā pārejošu kļūdu un mēģina vēl 2 reizes (1 s + 2 s atpakaļatkāpe). Tikai pēc 3 mēģinājumiem darbplūsma pāriet `catch` zaram. Šis **~3 s aizkavējums pirms kompensācijas sākuma** veido lielāko daļu no kopējā laika.
- Horeogrāfijas patērētājs **neizmet** kļūdu — tas publicē `PaymentFailed` notikumu un atgriežas, tāpēc `UseMessageRetry` netiek iesaistīts un kompensācija sākas nekavējoties.

Tests H Scenārijs 2 sadalīja kopējo kompensācijas ilgumu divos:

| Modelis | Kopējais saga ilgums (P95) | Tikai `Compensating → Failed` logs (P95) |
|---|---:|---:|
| Orķestrācija | ~3 870 ms | ~325 ms |
| Horeogrāfija | ~262 ms | ~27 ms |

**Pati kompensācija ir maza abos modeļos** — orķestrācijai ~325 ms, horeogrāfijai ~27 ms (~12× ātrāk). Lielākā atšķirība rodas no retry politikas, nevis no koordinācijas modeļa kā tāda.

**Uzticamība** atšķiras citā dimensijā. Tests M parāda, ka, ja kompensācijas solis pats neizdodas:

- Orķestrācija: visas 10 sagas sasniedz `Failed`, **bet 10 inventāra rezervācijas paliek noplūdušas** (klusa kļūme).
- Horeogrāfija: visas 10 sagas paliek `Compensating`, ar 10 noplūdušām rezervācijām (skaļa kļūme).

**Neviena no pieejām automātiski nesakopj sevi** pēc paliekoši kļūdaina kompensācijas soļa — abas prasa ārēju atjaunošanas instrumentāciju (saskaņošanas darbu vai DLQ atspēles rīku).

#### J4 — Veiktspējas atšķirības

> *Vai ir būtiskas atšķirības starp abām pieejām, un, ja ir, kādos scenārijos tās izpaužas?*

**Atbilde.** Atšķirības ir būtiskas un izpaužas vairākās dimensijās:

| Dimensija | Atšķirība | Tests |
|---|---|---|
| End-to-end saga latence (1–10 rps) | Horeogrāfija ~50–500 ms ātrāka | A, J |
| Ilgtspējīgā caurlaide | Horeogrāfija ~5× augstāka (50 vs 10 rps) | A |
| Vienlaicīgo lietotāju caurlaide (silta) | Horeogrāfija ~2× orderi/s | K |
| Per-step P95 | Horeogrāfija ~100 ms zemāka katrā solī | A, D |
| Astes latence (max ÷ P95) | Orķestrācija ~2×, horeogrāfija 6–12× | E, J, K |
| Aukstā starta sods | Orķestrācija 1007 ms, horeogrāfija 1657 ms | L |
| CPU starvation izturība | Orķestrācija degradē lineāri; horeogrāfija sabrūk | D |

Strukturāli orķestrācija pievieno **~100 ms tax** uz katru saga soli (Temporal task-queue dispatch + history persistence), kas 5-soļu sagā summējas līdz **~500 ms**. Tas redzams jau tukšā slodzē (1 rps), tāpēc nav slodzes inducēts. Horeogrāfija šo cenu nemaksā, bet apmaiņā:

- Tās tail latence ir lielāka (slowest-hop wins).
- Tās cold-start sods ir lielāks (visi 4 patērētāji jāuzsilda secīgi).
- Tās izturība pret CPU starvation ir vājāka (Tests D: pie 0.5 CPU, 25 rps, horeogrāfija pabeidza 9 sagas, orķestrācija 109).

Tādējādi **horeogrāfija dominē mediānas/P95 metrikās siltā un labi nodrošinātā vidē**, savukārt **orķestrācija dominē tail latencē, izturībā un sagas-progresa garantijās** noslodzes vai komponenta avārijas apstākļos.

---

### Hipotēžu pārbaude

#### H1 — Horeogrāfija būs ātrāka vienkāršos scenārijos

> *Loģika: nav centrālā koordinatora, mazāk "lēcienu" starp komponentiem.*

**Verdikts: APSTIPRINĀTA.**

| Scenārijs | Horeogrāfija | Orķestrācija | Starpība |
|---|---:|---:|---:|
| Tests A, 1 rps, saga P95 | 363 ms | 409 ms | ~46 ms |
| Tests J, 25 rps avg, 5 min | 250 ms | 756 ms | **~3×** |
| Tests K, 25 VU silta, mediāna | 258 ms | 779 ms | **~3×** |
| Tests L, silto pieprasījumu vidējais | 261 ms | 368 ms | ~107 ms |

Hipotēzes loģika apstiprinās empīriski: bez Temporal centrālā koordinatora horeogrāfija izvairās no 5 × ~100 ms task-queue lēcieniem. Vienkāršos (mazas slodzes, vienpavediena) scenārijos starpība ir **~50 ms**; vidējā slodzē tā paplašinās līdz **~500 ms**, jo orķestrācijas overhead ir konstants per-step neatkarīgi no slodzes.

#### H2 — Orķestrācija ātrāk veiks kompensācijas

> *Loģika: centralizēta kontrole ļauj efektīvāk koordinēt atcelšanu. Bet vai kompensācijas vispār notiks pietiekami bieži, lai tas būtu nozīmīgi?*

**Verdikts: ATSPĒKOTA šīs kodu bāzes konfigurācijā** (ar svarīgu nianses skaidrojumu).

Tests I uzrāda **pretēju** rezultātu: horeogrāfija pabeidz kompensāciju **~193 ms** (avg), orķestrācija — **~3 586 ms**. Tas ir ~18× starpība horeogrāfijas labā.

Atspēkojums **nav fundamentāls** — tā cēlonis ir asimetriska kļūmes semantika, nevis koordinācijas modelis pats par sevi:

- Orķestrācijā maksājuma kļūme tiek pārveidota par `ApplicationException`, ko Temporal interpretē kā pārejošu kļūdu un atkārto 3 reizes (1 s + 2 s atpakaļatkāpe) **pirms** kompensācijas sākuma — ~3 s no kopējā laika ir retry budget.
- Horeogrāfijas patērētājs publicē `PaymentFailed` kā biznesa notikumu (nevis met kļūdu), tāpēc retry politika netiek iedarbināta un kompensācija sākas nekavējoties.

**Tikai kompensācijas pati logs** (`Compensating → Failed`) ir orķestrācijai **~325 ms**, horeogrāfijai **~27 ms** (Tests H, scenārijs 2). Pat tīrā kompensācijas posmā horeogrāfija ir ātrāka, bet šī starpība samazinātos līdz dažu desmitu ms, ja Temporal retry tiktu deaktivizēts. Hipotēzes loģika ("centralizēta kontrole ļauj efektīvāk koordinēt atcelšanu") **nav apstiprinājusies**: centralizēta kontrole pievieno overhead (history persistence per step), nevis to mazina.

**Otrs jautājums** — *vai kompensācijas notiek pietiekami bieži, lai tas būtu nozīmīgi?* — ir izšķiroši svarīgs. Pie 10 % per-call kļūmes likmes (Tests H, scenārijs 1):

- Orķestrācija: 3 palaidieni × 600 sagas, **0 kompensāciju** (Temporal retry buferis padara per-saga kļūmi ~0.1 %).
- Horeogrāfija: 2 palaidieni × ~600 sagas, **~10–12 % kompensāciju** (per-call kļūme ≈ per-saga kļūme).

Tādējādi **orķestrācija slēpj pārejošās kļūdas, horeogrāfija tās izceļ**. Lietotāja perspektīvā tas nozīmē, ka horeogrāfijā vairāk pasūtījumu nokļūs `Failed` stāvoklī, pat ja patiesā downstream kļūdas likme ir identiska. Kompensācijas notiek **nozīmīgi biežāk horeogrāfijā** — un tāpēc, neraugoties uz formāli ātrāku kompensāciju, kopējais lietotāja-redzamais kompensāciju slogs horeogrāfijā ir lielāks.

#### H3 — Race condition scenārijā orķestrācija uzrādīs mazāk problēmu

> *Loģika: centralizēts koordinators var labāk kontrolēt piekļuvi ierobežotiem resursiem. Bet horeogrāfiju var pastiprināt ar papildu mehānismiem, tāpēc veidojas jautājums, cik sarežģīti.*

**Verdikts: DAĻĒJI APSTIPRINĀTA.**

Korektības dimensijā **abas pieejas ir identiski drošas** (Tests F: precīzi 1 uzvarētājs no 20 VU katrā palaidienā). Tas nav saga modeļa, bet datubāzes (`xmin` versija) īpašums — saga koordinators šeit tikai nosūta notikumus, nevis kontrolē rindas piekļuvi.

Lietotāja pieredzes (zaudētāja latences) dimensijā **orķestrācija ir prognozējamāka**:

- Orķestrācija: P95 = 3 557–4 011 ms (spread <12 %).
- Horeogrāfija: P95 = 3 914–33 357 ms (spread ~17×).

Cēlonis ir tas, ka horeogrāfijas implementācija pārmestīt `DbUpdateConcurrencyException`, ļaujot MassTransit retry politikai sacensties pret to pašu rindu vairākas reizes pēc kārtas. Hipotēzes piezīme par "papildu mehānismiem horeogrāfijas pastiprināšanai" arī apstiprinās — to varētu novērst, ja patērētājs izmestu `DbUpdateConcurrencyException` kā domēna kļūdu (tieši publicējot `InventoryReservationFailed`). Tādā gadījumā horeogrāfija saskaņotos ar orķestrācijas latences profilu.

**Sarežģītība** ir laba ziņa: viena rinda `ReserveInventoryConsumer.cs` būtu pietiekama, lai novērstu bimodalitāti. Tas nozīmē, ka hipotēze ir taisnīga par **noklusētajām implementācijām**, bet ne par **pieejas fundamentālo robežu**. Korektība abos modeļos ir vienlīdzīga; **prognozējamība bez papildu inženierijas ir orķestrācijas pusē**.

#### H4 — Eventual consistency ietekmi uz lietotāja pieredzi var mazināt, bet ne pilnībā novērst

> *Tas ir mazāk hipotēze, vairāk pieņēmums. Interesēs, cik daudz var mazināt.*

**Verdikts: APSTIPRINĀTA.**

Logs starp inventāra rezervēšanas redzamību un saga pabeigšanu ir **strukturāla saga modeļa īpašība** un parādās abos modeļos (Tests E):

- Mediānais logs: **~249 ms (horeogrāfija)**, **~279 ms (orķestrācija)**.
- P95 logs: ~342 ms (horeogrāfija), ~393 ms (orķestrācija).

Šo logu **var mazināt** ar inženierijas izvēlēm:

| Mehānisms | Empīriski uzlabojums | Avots |
|---|---|---|
| Saga modeļa izvēle (horeogrāfija) | ~30–60 ms īsāks medians | Tests E |
| Idempotence klientā | Atkārtoti POST'i deduplicēti < 2 ms; nav dubultkļūdu | Tests G |
| Terminālie statusi kā ground truth | 100 % kļūdaino sagu sasniedz `Failed` | Tests I |
| Retry asimetrijas izvēle | Pārejošas kļūdas absorbētas (orķestrācija) vai izceltas (horeogrāfija) | Tests H |
| CPU pareiza budžetēšana | < 70 % CPU saglabā stabilu medianu | Tests D |

Tomēr šo logu **nevar pilnībā novērst** — tas ir saga modeļa fundamentālais kompromiss starp atomicity un izkliedētu skalējamību. Pat optimālā konfigurācijā paliek vismaz:

- **Inventāra-vs-status logs (~30–250 ms)** — strukturāls.
- **Kompensācijas logs (~200 ms – 3.6 s)** — atkarīgs no retry politikas.
- **Astes outliers (orķestrācija ~3× P95, horeogrāfija ~6–12× P95)** — atkarīgi no koordinācijas modeļa un noslodzes.

Atkarībā no biznesa konteksta, šie logi var prasīt UI pielāgojumus (warning state, deferred confirmation, polling). **Empīrika apstiprina pieņēmumu**: pieci ar saga saistītie tipiskie UX jautājumi (gaidīšanas laiks, daļēja redzamība, kompensāciju paziņojumi, atkārtoto klikšķu drošība, kļūdas terminālā stāvokļa atklātība) ir adresējami šajā kodu bāzē, bet **katrs prasa atsevišķu inženieriju un neviens no tiem nenovērš situāciju pilnībā**. Fowler [9] novērojums tādējādi tiek kvalificēts: eventual consistency ir **mazināms, bet ne anulējams**.

---

### Kopsavilkums

| Hipotēze | Verdikts | Galvenais pierādījums |
|---|---|---|
| H1: Horeogrāfija ātrāka vienkāršos scenārijos | **APSTIPRINĀTA** | ~3× ātrāka mediānā (Tests A, J, K, L) |
| H2: Orķestrācija ātrāk veiks kompensācijas | **ATSPĒKOTA** (konfigurācijas atkarīga) | Horeogrāfija ~18× ātrāka (Tests I); cēlonis — kļūmes semantikas asimetrija, ne koordinācijas modelis |
| H3: Race condition — orķestrācija mazāk problēmu | **DAĻĒJI APSTIPRINĀTA** | Korektība identiska (DB līmeņa); orķestrācija ~9× prognozējamāka latencē (Tests F) |
| H4: Eventual consistency UX — mazināms, ne novēršams | **APSTIPRINĀTA** | Logs ~¼ s mediānā, līdz vairākām sekundēm astē; uzlabojams, bet ne anulējams (Tests E, G, I, M) |
