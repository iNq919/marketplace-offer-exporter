# Allegro + Ceneo + OLX Offer Exporter for ChatGPT v1.4.0

Rozszerzenie Chrome Manifest V3 do eksportowania ofert z Allegro, produktów z Ceneo i ogłoszeń z OLX.

## Najważniejsze funkcje

- osobny stan, wynik i historia dla Allegro, Ceneo i OLX
- możliwość uruchomienia wszystkich trzech serwisów równolegle, po jednej otwartej karcie na serwis
- automatyczne przechodzenie po stronach wyników
- pomijanie wcześniej poprawnie wyeksportowanych pozycji
- OLX: zbieranie tytułu, ceny, stanu, parametrów, lokalizacji, daty, typu sprzedawcy i opisu
- opisy OLX zachowują informacje o SMART, przebiegu i stanie, jeśli sprzedający podał je w treści
- eksport TXT/JSON oraz dzielenie tekstu na fragmenty do ChatGPT
- nieudane pobrania nie są dodawane do historii i mogą zostać ponowione

## Instalacja / aktualizacja

1. Rozpakuj ZIP.
2. Otwórz `chrome://extensions`.
3. Włącz tryb dewelopera.
4. Jeśli aktualizujesz tę samą instalację, podmień pliki w folderze rozszerzenia i kliknij Odśwież. Dzięki temu historia w `chrome.storage.local` pozostanie.
5. Jeśli instalujesz od nowa, użyj `Załaduj rozpakowane`.
6. Po aktualizacji odśwież otwarte karty Allegro, Ceneo i OLX.

## Równoległe uruchomienie 3 serwisów

Otwórz po jednej karcie z filtrami Allegro, Ceneo i OLX, a następnie kliknij `Uruchom Allegro + Ceneo + OLX`. Każdy crawler działa w swojej karcie i na swoim originie.

## OLX

Rozszerzenie rozpoznaje ogłoszenia po adresach `/d/oferta/...-ID....html`, skanuje paginację `page=N` i usuwa duplikaty po stabilnym identyfikatorze z URL. Przy ofertach używanych warto korzystać z trybu AI compact lub pełnego opisu, bo informacje o SMART i Power On Hours często są wyłącznie w opisie.
