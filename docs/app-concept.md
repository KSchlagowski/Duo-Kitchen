# Koncepcja aplikacji: planer posiłków i meal prepu

Dokument opisuje pomysł i ustalone decyzje. Jest punktem wyjścia dla Claude Code przy budowie aplikacji.

---

## 1. Cel

Aplikacja dla dwóch osób gotujących razem, która:
- pomaga zdecydować, co jeść,
- automatycznie przelicza porcje pod makroskładniki każdej osoby,
- tworzy listy zakupów,
- układa harmonogram gotowania (meal prep) i prowadzi przez gotowanie krok po kroku.

Główna idea: gotujemy hurtowo rano i wieczorem, a w ciągu dnia tylko odgrzewamy w mikrofalówce albo jemy prosto z pudełka.

---

## 2. Technologia

- **PWA**: działa w przeglądarce na komputerze, instalowalna na Androidzie i iOS.
- **Frontend**: Astro (JavaScript).
- **Backend / baza / auth**: Supabase.
- **Hosting**: Vercel.
- **AI**: dostęp przez OpenRouter, używany tylko tam, gdzie to konieczne.
  - Przeliczanie makro i harmonogram gotowania są deterministyczne, bez LLM.
  - Cel: niskie koszty utrzymania i przewidywalne wyniki.
- **Integracja z Claude**: przez konektor MCP (szczegóły w sekcji 12).
- Kod budowany jest przez Claude Code.

---

## 3. Interfejs

- UI dwujęzyczne, **polski i angielski**, z przełącznikiem w ustawieniach. Od pierwszej wersji.
- Tryb **jasny i ciemny**, z przełącznikiem. Od pierwszej wersji.
- Treść przepisów tylko po polsku (wersja angielska to plan na później).
- Instrukcja lub onboarding dla nowych użytkowników, wyjaśniający podstawowy przepływ:
  1. konto,
  2. połączenie z partnerem,
  3. cele makro,
  4. wybór posiłków,
  5. przeliczenie makro,
  6. zakupy,
  7. gotowanie.

---

## 4. Użytkownicy i konta

- Każda osoba zakłada własne konto.
- Dwa konta można **połączyć** we wspólne gospodarstwo. Połączone konta widzą te same przepisy, plany i listy zakupów.
- Każdy użytkownik ręcznie wpisuje swoje **cele dzienne**: kalorie, białko, tłuszcze, węglowodany.
  - Nie ma żadnego kalkulatora zapotrzebowania (BMR, TDEE itp.).
- Na start aplikacja jest dla jednej pary. Obsługa innych par jest możliwa kiedyś, ale architektura nie musi tego teraz rozwiązywać na siłę.

---

## 5. Planowanie posiłków

- Plan obejmuje **3 kolejne dni, po 5 posiłków dziennie** (zwykle 15 posiłków).
- Krótki cykl 3 dni jest celowy: dzięki niemu jedzenie nie zdąży się zepsuć. Aplikacja nie śledzi trwałości produktów ani terminów przydatności.
- Obie osoby jedzą **te same dania**, w różnych ilościach.
- Dla każdego posiłku albo całego dnia użytkownik wybiera, dla kogo gotuje: **tylko A, tylko B albo dla obojga**.
- Można zaplanować mniej posiłków, np. gdy jakiś zjecie na mieście.
- Jedno ugotowane danie może pokryć posiłki w kilku dniach (np. obiad na 2–3 dni).

### Typy posiłków
- Typy: śniadanie, II śniadanie, obiad, podwieczorek, kolacja.
- Każdy przepis ma **od 0 do 2** sugerowanych typów, np. ciastko proteinowe: II śniadanie lub podwieczorek; krewetki: obiad lub kolacja.
- Typ to tylko podpowiedź i filtr. Użytkownik może wstawić dowolny przepis w dowolne miejsce planu.

---

## 6. Przeliczanie makro (solver)

### Zasada działania
- Liczenie jest **deterministyczne**, metodą **programowania liniowego** (LP), bez AI.
- Gotuje się jedną dużą porcję, którą solver dzieli między osoby.
- Solver dobiera:
  - ile każdego składnika lub komponentu ugotować,
  - jak podzielić je między osobę A i B.
- Podział może być na poziomie:
  - **komponentów** (np. A dostaje 60% ryżu i 70% sosu),
  - **całego dania**, gdy komponentów nie da się rozdzielić.
  - Przepis określa, który wariant jest możliwy.
- Cel optymalizacji: **cele dzienne** każdej osoby, czyli suma wszystkich posiłków danego dnia. Pojedyncze posiłki nie muszą trafiać w makro.

### Tolerancja
- Domyślnie **±10%** dla każdego makro: kalorie, białko, tłuszcze, węglowodany.

### Kiedy i jak się uruchamia
- Gdy użytkownik zapełni dzień 5 posiłkami, pojawia się okienko z propozycją przeliczenia i przyciskiem **„Przelicz makro”**. Użytkownik decyduje, czy przelicza. Przycisk jest też dostępny ręcznie.
- Jeśli solver nie znajdzie rozwiązania w ±10%, aplikacja pokazuje okienko z propozycją przeliczenia z tolerancją **±15%**.
- Jeśli nadal brak rozwiązania, kolejna propozycja: **±20%**.
- Jeśli nadal brak rozwiązania, aplikacja pokazuje **komunikat o błędzie** wskazujący, który przepis najbardziej przeszkadza w dopasowaniu (np. ma za dużo tłuszczu względem celów).
- Aplikacja **nigdy nie blokuje** użytkownika. Plan zawsze można zapisać i używać bez przeliczenia.

### Ograniczenia dla solvera
- **Minimalna sensowna ilość** składnika lub dania (np. jajka sadzone to minimum 1 jajko).
- Składniki liczone w **sztukach** dzielone są na całe sztuki (ewentualnie połówki, jeśli przepis na to pozwala).

### Zaokrąglanie wyników
- Wyniki mają być praktyczne do odważenia: „dodaj 150 g”, a nie „dodaj 147,5 g”.
- Każdy składnik ma własny **krok zaokrąglenia**:
  - produkty sypkie, mięso, warzywa itp.: np. co 10 g,
  - proszek do pieczenia, sól, przyprawy, drożdże itp.: dokładnie, co 1 g (6 g nie może stać się 10 g),
  - sztuki: całe sztuki lub połówki.
- Ważenie może odbywać się **przed i/lub po** ugotowaniu. Przepis musi znać wagę surową i wagę po ugotowaniu tam, gdzie to istotne (np. ryż, makaron).
- Gdy coś dzieli się na pół, aplikacja może napisać „podziel na pół” bez gramatury.

---

## 7. Mieszanki przypraw i bulion

### Mieszanki przypraw
- Osobna sekcja w UI z **przepisami na mieszanki** (np. przyprawa do kurczaka), przygotowywane przez użytkownika raz na jakiś czas.
- Przy przepisie użytkownik wybiera: **oryginalne pojedyncze przyprawy** albo **jedna z mieszanek**.
- Mieszanki **nie mają makro** i aplikacja **nie śledzi ich zapasu**.
- Na liście zakupów mieszanka pojawia się jako **pozycja główna z podpozycjami**, którymi są jej składniki. Dzięki temu użytkownik może dokupić składniki, jeśli chce ją dorobić.

### Bulion
- Przy przepisie użytkownik wybiera: **bulion z kostki** albo **domowy**.
- To tylko opcja. Domowy bulion nie jest osobnym przepisem i nie trafia do harmonogramu.

---

## 8. Harmonogram gotowania (meal prep)

- Gotowanie odbywa się **rano i wieczorem**. W ciągu dnia tylko odgrzewanie lub jedzenie z pudełka.
- Aplikacja sama układa **sesje gotowania**, łącząc kroki z wielu przepisów, np. „poniedziałek wieczór: ugotuj ryż, sos i jajka na wtorek”.
- Zasady układania:
  - co się da, gotuje się **wieczorem** (wcześniej),
  - **rano** tylko to, co musi być świeże (np. jajecznica).
- Logika jest deterministyczna. LLM tylko wtedy, gdy okaże się niezbędny.
- **Tryb gotowania krok po kroku**: wyświetla kolejne kroki sesji, z porcjami przeliczonymi dla A i B.

---

## 9. Lista zakupów

- Generuje się automatycznie z planu, z ilościami dla obu osób.
- Produkty są **pogrupowane według działów sklepu**.
- Lista pokazuje wszystko. Użytkownik sam skreśla to, co ma w domu. Brak śledzenia spiżarni.
- Mieszanki przypraw: pozycja główna z podpozycjami (patrz sekcja 7).
- **Działa offline**: odhaczanie produktów bez zasięgu. To jedyna funkcja, która musi działać offline.

### Synchronizacja między osobami
- Na liście jest przycisk **„Synchronizuj”**.
- Gdy osoba A go naciśnie, jej lista dostaje zaznaczenia wykonane przez osobę B (i odwrotnie).
- Synchronizacja działa **tylko przy zaznaczaniu**, nigdy przy odznaczaniu. Założenie: podczas zakupów produkty tylko trafiają do koszyka, nikt ich nie wyjmuje.
- Synchronizacja nie musi działać na żywo.

---

## 10. Przepisy

### Wyświetlanie
- Karta przepisu pokazuje:
  - zdjęcie,
  - nazwę,
  - rodzaj kuchni (np. polska),
  - ocenę obu osób: łapka w górę lub w dół. Każdy widzi swoją ocenę i ocenę partnera.

### Filtrowanie i sortowanie
- Filtry:
  - rodzaj kuchni,
  - typ posiłku,
  - czas przygotowania (w przedziałach),
  - minimalna sensowna kaloryczność (np. minimum 1 jajko w jajkach sadzonych).
- Domyślnie na końcu listy lądują przepisy z **łapką w dół od którejkolwiek osoby**.

### Zawartość przepisu
- Lista składników z ilościami, makro i krokiem zaokrąglenia.
- Kroki przygotowania, podzielone na te, które można zrobić wcześniej (wieczorem), i te, które muszą być na świeżo.
- Komponenty, które można dzielić osobno (np. ryż, sos, mięso), albo informacja, że danie dzieli się tylko w całości.
- Waga surowa i po ugotowaniu tam, gdzie to istotne.
- Od 0 do 2 sugerowanych typów posiłku.
- Rodzaj kuchni i czas przygotowania.
- Opcjonalnie: przyprawy zastępowalne mieszanką, użycie bulionu.

### Dane startowe
- Kilka testowych przepisów (wygenerowanych lub z internetu) razem z kodem i danymi do testów.

---

## 11. Baza produktów i makro

- Baza produktów z wartościami odżywczymi jest **trzymana w repozytorium**.
- Produkty dodawane są **ręcznie lub przez Claude'a**.
- Makro przepisu liczy się z produktów w bazie.

---

## 12. Claude jako użytkownik (konektor MCP)

- Claude ma dostęp do aplikacji przez konektor MCP dodany w Claude.ai i działa jak osobny użytkownik.
- Może:
  - **dodawać przepisy** ze zdjęcia i opisu,
  - **edytować** istniejące przepisy,
  - **układać plan** posiłków.
- Claude działa **wyłącznie na polecenie** użytkownika. Nigdy nic nie robi sam z siebie.

### Przepływ dodawania przepisu
1. Użytkownik wrzuca zdjęcie i opis.
2. Claude redaguje treść i dzieli przepis na kroki (jeśli trzeba).
3. Claude rozmawia z użytkownikiem o tym, czego brakuje, co dodać, co zmienić, a co zostawić.
4. Po akceptacji użytkownika Claude zapisuje przepis do bazy i pojawia się on w aplikacji.

### Kolejność źródeł danych o produktach (instrukcja dla Claude'a)
1. Produkty wpisane ręcznie przez użytkownika.
2. Baza produktów w repozytorium.
3. Internet.
4. Wiedza własna modelu.

---

## 13. Czego świadomie NIE robimy

- Kalkulatorów zapotrzebowania kalorycznego.
- Śledzenia spiżarni, zapasów i mieszanek przypraw.
- Śledzenia trwałości jedzenia i terminów przydatności (cykl 3-dniowy to rozwiązuje).
- Makro dla mieszanek przypraw.
- Blokowania użytkownika, gdy makro się nie zgadza.
- Samodzielnych działań Claude'a bez polecenia.
- Synchronizacji odznaczeń na liście zakupów.

---

## 14. Na później

- Przepisy w wersji angielskiej.
- Filtry dietetyczne: wegetariańskie, wegańskie, bezglutenowe, alergeny.
- Udostępnienie aplikacji innym parom i użytkownikom.
