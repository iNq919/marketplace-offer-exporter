# Allegro + Ceneo + OLX Offer Exporter v1.6.0

Rozszerzenie Chrome zbiera oferty z Allegro, produkty z Ceneo i ogłoszenia z OLX oraz przygotowuje eksport TXT/JSON i fragmenty do wklejenia do ChatGPT.

## Najważniejsze zmiany v1.6.0

- Zadania nie działają już w karcie Allegro/Ceneo/OLX. Po uruchomieniu są wykonywane w dokumencie tła rozszerzenia.
- Możesz zamknąć kartę źródłową po rozpoczęciu skanu. Eksport nadal działa.
- Wynik częściowy jest zapisywany co kilka sekund podczas pobierania szczegółów.
- Przycisk `Pokaż wynik` pokazuje faktyczny tekst fragmentu w polu w popupie, a nie tylko metadane.
- Przycisk `Wznów` uruchamia ponownie zapisany adres i pomija pozycje, które zdążyły zostać poprawnie zapisane w historii.
- Historia jest aktualizowana partiami już w trakcie pracy, a nie dopiero po zakończeniu całego skanu.
- Jeden globalny limit workerów jest dynamicznie dzielony pomiędzy Allegro, Ceneo i OLX. Gdy jeden serwis kończy, wolne workery automatycznie przechodzą do pozostałych.
- Limity są adaptacyjne. Przy 403/429 liczba równoległych requestów dla danego serwisu spada i włącza się cooldown. Po serii sukcesów wydajność rośnie ponownie.
- Ceneo nie wykonuje już wielokrotnych długich retry dla błędów, które nie wyglądają na przejściowe. Druga próba dotyczy tylko błędów sieciowych, ochrony, 403/429 i 5xx.
- Allegro dodatkowo wyprowadza adres `/oferty-produktu/...` bezpośrednio z każdego linku `/produkt/...`, więc nie zależy wyłącznie od tego, czy link `zobacz X ofert` znajduje się w statycznym HTML.
- Rozwijanie grup Allegro działa równolegle i korzysta z tego samego globalnego limitu workerów.

## Instalacja / aktualizacja

1. Rozpakuj ZIP.
2. Wejdź do `chrome://extensions`.
3. Włącz tryb programisty.
4. Jeśli aktualizujesz poprzednią wersję w tym samym folderze, podmień pliki i kliknij `Odśwież` przy rozszerzeniu.
5. Przy pierwszej instalacji kliknij `Załaduj rozpakowane` i wskaż folder rozszerzenia.

Nie usuwaj starego wpisu rozszerzenia, jeśli chcesz zachować `chrome.storage.local` z historią i poprzednimi wynikami.

## Używanie 3 serwisów jednocześnie

1. Otwórz po jednej karcie Allegro, Ceneo i OLX z ustawionymi filtrami.
2. Otwórz popup rozszerzenia.
3. Kliknij `Uruchom Allegro + Ceneo + OLX`.
4. Po uruchomieniu karty możesz zamknąć. Zadania wykonują się w tle rozszerzenia.

Domyślne ustawienia v1.6:

- 6 workerów globalnie,
- 700 ms bazowej przerwy adaptacyjnej,
- workery dzielone automatycznie pomiędzy aktywne serwisy.

Dla Allegro wewnętrzny limit wynosi 3, dla Ceneo 5, dla OLX 5. Gdy działają trzy serwisy, scheduler pilnuje współdzielenia globalnego limitu. Gdy zostanie jeden serwis, może wykorzystać większą część puli.

## Przerwanie i wznowienie

Poprawne pozycje są zapisywane do historii już podczas pobierania. Wynik częściowy również trafia do storage.

Jeżeli przerwiesz zadanie:

1. `Pokaż wynik` pozwala skopiować to, co zdążyło się pobrać.
2. `Wznów` uruchamia ten sam zapisany URL.
3. Poprawne ID z historii są pomijane.
4. Błędy i niepobrane pozycje są próbowane ponownie.

Jeśli dokument tła zostanie przerwany np. po restarcie Chrome, otwarcie popupu wykonuje kontrolę stanu i próbuje automatycznie wznowić zadania, które w storage nadal mają stan `running` i zapisany adres źródłowy.

## Allegro

Allegro grupuje wiele ofert sprzedawców w jedną kartę produktu. Eksporter:

1. skanuje karty produktów,
2. zbiera jawne linki `zobacz X ofert`,
3. dodatkowo tworzy adres porównania z linku `/produkt/...`,
4. pobiera strony `/oferty-produktu/...`,
5. zbiera indywidualne ID ofert,
6. ponownie stosuje cenę i stan z URL źródłowego,
7. pobiera szczegóły każdej unikalnej oferty.

## Ceneo

Ceneo może ograniczać dużą serię requestów. Scheduler v1.6 reaguje na 403/429 automatycznym cooldownem i czasowym zmniejszeniem równoległości. Błędy nieprzejściowe nie są mielone w kilku długich seriach retry.

## OLX

OLX działa analogicznie. Każde ogłoszenie ma własne ID, a opis jest zachowywany, ponieważ często właśnie tam znajdują się SMART, przebieg, bad sectory, rok produkcji i warunki sprzedaży.
