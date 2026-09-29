# Allegro + Ceneo Offer Exporter for ChatGPT 1.3.0

Rozszerzenie Chrome Manifest V3 do zbierania ofert z Allegro i produktów z Ceneo.

## Co poprawiono w 1.3.0

- Allegro nie kończy już skanowania na podstawie widocznych numerów paginacji.
- Allegro nie traktuje liczby znalezionej w dowolnym napisie `X ofert` jako pewnej granicy skanowania.
- Dla Allegro rozszerzenie przechodzi kolejne strony tak długo, jak pojawiają się nowe ID ofert. Dwie kolejne strony bez nowych ID kończą skan.
- W eksporcie podawana jest rzeczywista liczba przeskanowanych stron. Widoczna paginacja jest tylko wskazówką diagnostyczną.
- Ceneo najpierw odczytuje wyłącznie główne karty produktów z listingu (`cat-prod-row` / `category-list-item`), dzięki czemu rekomendacje i podobne produkty nie powinny wpadać do wyniku.
- Jeśli Ceneo zmieni HTML i trzeba użyć fallbacku, rozszerzenie dodatkowo sprawdza aktywne filtry z URL, np. `Pojemnosc:2TB,4TB` i `Interfejs:SATA,SATA3`.
- Karta Ceneo może zostać zebrana również wtedy, gdy nie ma widocznej ceny `od`, jeśli należy do głównej listy. Dzięki temu liczba pozycji powinna lepiej odpowiadać liczbie deklarowanej przez Ceneo.
- Nadal działają osobne stany, wyniki i historia dla Allegro oraz Ceneo.
- Nadal można uruchamiać oba serwisy jednocześnie.

## Dlaczego powstała ta poprawka

W poprzednim przebiegu:

- Allegro pokazywało 589 ofert, ale rozszerzenie zatrzymało się po 4 stronach i znalazło tylko 148.
- Ceneo deklarowało 279 produktów, a rozszerzenie zebrało 287, ponieważ do wyniku wpadały także produkty z modułów rekomendacji, np. pojemności spoza aktywnego filtra.

## Instalacja / aktualizacja

1. Rozpakuj ZIP.
2. Jeśli masz już rozszerzenie załadowane z folderu, podmień jego pliki nową wersją.
3. Wejdź w `chrome://extensions`.
4. Kliknij `Odśwież` przy rozszerzeniu.
5. Odśwież otwarte karty Allegro i Ceneo.

Nie usuwaj rozszerzenia z Chrome, jeśli chcesz zachować jego aktualną historię w `chrome.storage.local`.

## Historia i pomijanie

Opcja `Pomiń wcześniej poprawnie wyeksportowane pozycje` działa osobno dla serwisów:

- Allegro po ID oferty.
- Ceneo po ID produktu.
- Błędy pobierania nie są oznaczane jako sprawdzone.
- Historię można wyczyścić osobno dla każdego serwisu.
- Można importować wcześniejsze eksporty TXT i JSON.

W folderze `history-import` są pliki pomocnicze zawierające pozycje z wcześniejszych eksportów:

- `allegro-reviewed.json` - 149 unikalnych ofert Allegro z dotychczasowych poprawnych eksportów.
- `ceneo-reviewed.json` - 396 unikalnych produktów Ceneo z dotychczasowych eksportów.

Jeśli aktualizujesz istniejącą instalację przez podmianę plików i `Odśwież`, zwykle nie musisz importować ich ponownie, bo historia rozszerzenia pozostaje w Chrome.

## Zalecane ustawienia

Dla dużego eksportu Allegro:

- równoległe pobieranie: 1
- przerwa: 1200-2000 ms
- tryb: AI compact
- `Maks. nowych pozycji: 0`, jeśli chcesz zebrać wszystkie jeszcze niesprawdzone pozycje

Dla Ceneo:

- 1-2 workery
- 600-1200 ms

Przy 500+ ofertach Allegro pełne pobieranie szczegółów może trwać kilkanaście minut lub dłużej.

## Równoległe Allegro + Ceneo

1. Otwórz kartę Allegro z filtrami.
2. Otwórz kartę Ceneo z filtrami.
3. Kliknij `Uruchom Allegro + Ceneo`.

Oba zadania mają osobny postęp, historię i eksport.

## Diagnostyka

Po zakończeniu zwróć uwagę na:

- `Strony` - ile stron faktycznie przeskanowano.
- `Znalezione` - liczba unikalnych ID znalezionych na listingach.
- `Pominięte` - pozycje już obecne w historii.
- `Kolejka` - nowe pozycje do pobrania.
- `Pobrane` i `Błędy` - wynik pobierania szczegółów.

Dla Allegro napis `widoczna paginacja do: X` jest tylko informacją o aktualnie widocznym fragmencie paginacji, a nie granicą skanowania.
