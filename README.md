# Allegro + Ceneo Offer Exporter for ChatGPT 1.2.0

Rozszerzenie Chrome Manifest V3 do zbierania ofert z Allegro i produktów z Ceneo.

## Co nowego w 1.2.0

- Allegro i Ceneo mają osobne stany, wyniki i historię.
- Można uruchomić eksport Allegro i Ceneo jednocześnie na dwóch otwartych kartach.
- Opcja pomijania wcześniej poprawnie wyeksportowanych pozycji.
- Historia jest przechowywana osobno dla Allegro i Ceneo.
- Można importować stare eksporty TXT i JSON do historii.
- Pozycje, które wcześniej zakończyły się błędem, nie są dodawane do historii i zostaną ponowione przy następnym eksporcie.
- Poprawione skanowanie paginacji Allegro. Rozszerzenie nie kończy już skanowania tylko dlatego, że na stronie wystąpił pierwszy napis typu "60 ofert".
- Dodane wykrywanie numerów stron z linków paginacji Allegro.
- Jedna pusta strona nie kończy skanowania, jeśli znamy całkowitą liczbę stron.
- Bezpieczniejsze pobieranie Allegro: dłuższy backoff dla HTTP 403/429/5xx, automatyczny cooldown oraz druga wolniejsza próba pobrania błędnych ofert.
- Domyślne ustawienia są spokojniejsze dla Allegro: 1 worker i 1200 ms przerwy.
- W UI widać osobno: strony, znalezione, kolejkę, pominięte z historii, pobrane i błędy.
- Eksport TXT zawiera diagnostykę liczby znalezionych pozycji, stron, pominiętych pozycji i błędów.

## Instalacja

1. Rozpakuj ZIP.
2. Otwórz `chrome://extensions`.
3. Włącz tryb dewelopera.
4. Kliknij `Załaduj rozpakowane`.
5. Wskaż folder rozszerzenia.

Przy aktualizacji istniejącej instalacji podmień pliki w folderze rozszerzenia i kliknij `Odśwież` na stronie rozszerzeń Chrome.

## Równoległe Allegro + Ceneo

1. Otwórz kartę Allegro z ustawionymi filtrami.
2. Otwórz kartę Ceneo z ustawionymi filtrami.
3. Otwórz popup rozszerzenia.
4. Kliknij `Uruchom Allegro + Ceneo`.

Każde zadanie działa w swojej karcie. Wyniki i postęp nie nadpisują się wzajemnie.

Możesz też uruchamiać serwisy osobno przyciskiem `Uruchom bieżącą kartę`.

## Historia i pomijanie pozycji

Domyślnie zaznaczona jest opcja `Pomiń wcześniej poprawnie wyeksportowane pozycje`.

- Allegro jest rozpoznawane po ID oferty.
- Ceneo jest rozpoznawane po ID produktu.
- Do historii trafiają tylko pozycje pobrane bez błędu.
- Historię można wyczyścić osobno dla każdego serwisu.
- Stary eksport TXT lub JSON można dodać przez `Importuj TXT / JSON`.
- Przy imporcie TXT bloki z `Błąd pobierania` są ignorowane.

To oznacza, że po nieudanym pobraniu oferta nie przepada i będzie mogła zostać pobrana w kolejnym uruchomieniu.

## Zalecane ustawienia

Dla Allegro przy dużej liczbie ofert:

- równoległe pobieranie: 1
- przerwa: 1200-2000 ms
- tryb AI compact

Dla Ceneo zwykle można użyć 2 workerów i 600-1000 ms, ale wspólne bezpieczne ustawienie dla obu serwisów to 1 worker i 1200 ms.

## Uwaga

Serwisy mogą zmieniać HTML, limity zapytań i zabezpieczenia. Przy dużych eksportach przetwarzanie może trwać długo. Nie zamykaj ani nie odświeżaj karty, na której działa dane zadanie.

## Historia przygotowana z dotychczasowych eksportów

W katalogu `history-import` są dwa pliki gotowe do jednorazowego importu:

- `allegro-reviewed.json` - 25 ofert Allegro, które w poprzednim eksporcie pobrały się poprawnie. 35 pozycji z błędem nie zostało dodanych, więc rozszerzenie spróbuje pobrać je ponownie.
- `ceneo-reviewed.json` - 370 produktów Ceneo z poprzedniego eksportu.

W popupie kliknij `Importuj TXT / JSON` i zaznacz oba pliki. Dzięki temu przy włączonym `Pomiń wcześniej poprawnie wyeksportowane pozycje` kolejne uruchomienie nie będzie pobierać tych samych pozycji ponownie.
