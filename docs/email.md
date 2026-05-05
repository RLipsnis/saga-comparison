**Tēma:** Maģistra darbs — saga modeļu salīdzinājuma testu rezultāti

Sveiki, [pasniedzēja vārds]!

Pabeidzu visu eksperimentālo testu kopumu (A, B, D, E, F, G, H, I, J, K, L, M, N, O) saga orķestrācijas (Temporal) un horeogrāfijas (MassTransit + RabbitMQ) salīdzinājumam. Pilna analīze ir failā `docs/results_analysed.md` (latviešu atbildes uz darba jautājumiem un hipotēzēm — `docs/results_analyse_lv.md`). Šeit īsumā galvenie atklājumi.

## Galvenie rezultāti

**1. Veiktspēja (happy ceļš).** Horeogrāfija ir ~3× ātrāka mediānā un sasniedz ~2× augstāku ilgtspējīgu caurlaidi uz tās pašas aparatūras. Atstarpe ir konstanta no 1 rps līdz 25 rps un strukturāla — orķestrācija pievieno ~100 ms uz katru saga soli (Temporal task-queue dispatch + history persistence), kas 5-soļu sagā summējas līdz ~500 ms (Tests A, J, K).

**2. Korektība ir identiska abos modeļos.** Pārpārdošanas novēršana, idempotence un kompensācijas korektība nāk no datubāzes (`xmin` rindas-versijas) un HTTP slāņa, nevis no saga modeļa (Tests F, G, I). Abi modeļi 100 % gadījumu sasniedz `Failed` ar atbrīvotu krājumu deterministiskā kļūmes scenārijā.

**3. Astes latence favorē orķestrāciju.** Horeogrāfijas max/P95 attiecība ir 6–12×; orķestrācijai — ~2×. Aukstā starta sods arī ir mazāks orķestrācijai (1007 ms vs 1657 ms), taču horeogrāfijas siltā stāvokļa priekšrocība šo sodu atmaksā pēc ~7 pieprasījumiem (Tests E, K, L).

**4. Noturība pret komponentu avārijām (svarīgākais ne-veiktspējas atklājums).**
- *Koordinatora avārija* (Tests O): orķestrācija atjaunoja 10/10 sagas ~17 s; horeogrāfija atstāja 6/10 iestrēgušas `Pending`, jo bez transactional outbox `OrderCreated` notikumi tika zaudēti starp HTTP 202 un brokera publikāciju.
- *Brokera pārtraukums* (Tests N): orķestrācija sasniedza 10/10 termināla stāvokli ~25 s; horeogrāfija atstāja 2/10 iestrēgušas pat pēc 90 s.
- *Kompensācijas soļa kļūme* (Tests M): neviens modelis pats neatjaunojas — orķestrācija atstāj **klusu** inventāra noplūdi (`Failed` + nepareizs krājums), horeogrāfija atstāj **redzami** iestrēgušas sagas. Abi prasa ārējus rīkus (saskaņošanas darbu vai DLQ atspēli).

**5. Kļūmes semantika dominē pār saga modeli.** Pie 10 % per-call maksājumu kļūmes likmes orķestrācija reģistrēja 0 kompensāciju (Temporal retry budžets absorbē kļūdas), horeogrāfija — ~10–12 %. Tā pati retry asimetrija izskaidro, kāpēc kompensācija ir ~18× lēnāka orķestrācijā (Tests H, I) — tas nav koordinācijas modeļa īpašums, bet konfigurācijas izvēle.

## Hipotēžu pārbaude

| Hipotēze | Verdikts | Pierādījums |
|---|---|---|
| H1: Horeogrāfija ātrāka vienkāršos scenārijos | **Apstiprināta** | ~3× ātrāka mediānā (Tests A, J, K, L) |
| H2: Orķestrācija ātrāk veiks kompensācijas | **Atspēkota** | Horeogrāfija ~18× ātrāka; cēlonis — kļūmes semantikas asimetrija, ne koordinācijas modelis (Tests I) |
| H3: Race condition — orķestrācija mazāk problēmu | **Daļēji apstiprināta** | Korektība identiska (DB līmenis), bet orķestrācija ~9× prognozējamāka latencē (Tests F) |
| H4: Eventual consistency UX — mazināms, ne novēršams | **Apstiprināta** | ~¼ s logs mediānā; mazināms ar UI/idempotenci, bet ne anulējams (Tests E, G, I) |

## Kopējais secinājums

Saga modeļa izvēle nav korektības jautājums (abi to nodrošina ekvivalenti), bet inženierijas kompromisu jautājums starp:

- **mediānas veiktspēju + caurlaidi** (horeogrāfijas labā), un
- **astes latences prognozējamību + crash-mid-saga durability** (orķestrācijas labā).

Esmu gatavs apspriest rezultātus klātienē vai tiešsaistē — lūdzu, paziniet ērtu laiku.

Ar cieņu,
[Tavs vārds]
