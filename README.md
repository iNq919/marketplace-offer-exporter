# Allegro + Ceneo Offer Exporter for ChatGPT

Rozszerzenie Chrome Manifest V3 do zbierania ofert z bieżącego filtrowania Allegro oraz produktów z porównywarki Ceneo.

## Obsługiwane serwisy

- Allegro: skanowanie wszystkich stron wyników, a następnie pobranie szczegółów każdej oferty.
- Ceneo: skanowanie wszystkich stron wyników, a następnie pobranie strony każdego produktu wraz z ceną od, oceną, liczbą sklepów/ofert, parametrami technicznymi i opisem.

Na Ceneo jedna pozycja zwykle reprezentuje produkt porównywany pomiędzy wieloma sklepami. Rozszerzenie nie duplikuje tego samego modelu dla każdego sklepu, tylko zapisuje cenę od oraz dostępne informacje o liczbie sklepów i ofert.

## Instalacja

1. Rozpakuj ZIP.
2. Wejdź w `chrome://extensions`.
3. Włącz `Tryb dewelopera`.
4. Kliknij `Załaduj rozpakowane`.
5. Wskaż folder `allegro-offer-exporter`.

Jeżeli aktualizujesz wcześniejszą wersję, po podmianie plików kliknij przy rozszerzeniu przycisk odświeżenia w `chrome://extensions`.

## Użycie

1. Otwórz kategorię lub wyszukiwanie Allegro albo Ceneo i ustaw filtry.
2. Możesz być na dowolnej stronie wyników.
3. Kliknij ikonę rozszerzenia.
4. Zostaw zaznaczone `Zacznij od strony 1`, jeżeli chcesz zebrać cały wynik filtrowania.
5. Wybierz tryb:
   - `AI compact`: najważniejsze parametry i skrócony opis.
   - `Pełne opisy`: bez skracania opisu.
6. Kliknij `Zbierz pozycje`.
7. Po zakończeniu kopiuj fragmenty po kolei do ChatGPT albo pobierz TXT/JSON.

## Uwagi

- Domyślnie rozszerzenie wykonuje 2 równoległe żądania i robi 500 ms przerwy po każdym produkcie/ofercie na worker.
- Przy Ceneo warto pozostawić 1-2 workery i 500-1000 ms przerwy.
- Jeśli serwis zacznie zwracać błędy 429 lub stronę ochronną, zwiększ przerwę do 1000-2000 ms i ustaw 1 worker.
- Eksport można przerwać przyciskiem `Przerwij`.
- Proces działa w aktywnej karcie serwisu. Nie odświeżaj ani nie zamykaj tej karty podczas pobierania.
- Wynik jest zapisywany w pamięci rozszerzenia, więc popup można zamknąć i otworzyć ponownie.

## v1.1.1

- poprawka błędu `Could not establish connection. Receiving end does not exist.` po instalacji/przeładowaniu rozszerzenia,
- popup automatycznie wstrzykuje `content.js` do aktywnej karty Allegro/Ceneo, jeśli skrypt nie został wcześniej załadowany,
- nie trzeba już ręcznie odświeżać strony po aktualizacji rozszerzenia.
