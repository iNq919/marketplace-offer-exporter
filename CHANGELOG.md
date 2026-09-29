# Changelog

Historia zmian rozszerzenia Marketplace Offer Exporter.

## v1.6.0

- Przeniesiono zadania do dokumentu tła, aby skan nie zależał od otwartej karty źródłowej.
- Dodano częściowe wyniki, przycisk `Wznów` i częstsze zapisywanie historii.
- Dodano globalny, dynamicznie współdzielony limit workerów.
- Dodano adaptacyjne ograniczanie równoległości i cooldown przy 403/429.
- Rozwijanie grup Allegro działa równolegle.
- Uwaga: ta wersja miała regresję parsera `findProductJsonLd is not defined`, naprawioną w v1.7.0.

## v1.5.0

- Dodano dwustopniowe skanowanie Allegro: karta produktu -> konkretne oferty sprzedawców.
- Rozwijane są strony `/oferty-produktu/...` i zbierane indywidualne ID ofert.
- Podstawowe filtry ceny i stanu są ponownie stosowane po rozwinięciu grup.
- Eksport rozróżnia liczbę kart produktów od liczby indywidualnych ofert.

## v1.4.0

- Dodano obsługę OLX.
- Dodano niezależny stan, wynik i historię OLX.
- Możliwe jest jednoczesne uruchomienie Allegro, Ceneo i OLX.
- OLX zbiera tytuł, cenę, stan, parametry, lokalizację, datę, sprzedawcę i opis.
- Ogłoszenia OLX są deduplikowane po stabilnym ID z adresu.

## v1.3.0

- Allegro przestało traktować widoczne numery paginacji jako twardą granicę skanu.
- Skan Allegro kończy się dopiero po kolejnych stronach bez nowych ID.
- Ceneo preferuje główne karty produktów i ogranicza zbieranie rekomendacji.
- Fallback Ceneo sprawdza filtry z URL, m.in. pojemność i interfejs.
- Rozszerzono diagnostykę liczby faktycznie przeskanowanych stron.

## v1.2.0

- Rozdzielono stan, wyniki i historię dla Allegro oraz Ceneo.
- Dodano równoległe uruchamianie dwóch serwisów.
- Dodano pomijanie wcześniej poprawnie wyeksportowanych ID i import historii TXT/JSON.
- Rozbudowano diagnostykę paginacji i liczników.
- Dodano spokojniejsze retry/backoff dla 403, 429 i 5xx.
- Dołączono pomocnicze pliki historii z wcześniejszych eksportów.

## v1.1.1

- Naprawiono błąd `Could not establish connection. Receiving end does not exist.` po instalacji lub przeładowaniu rozszerzenia.
- Popup automatycznie wstrzykuje `content.js`, gdy odbiornik wiadomości nie jest jeszcze dostępny.
- Obsługa eksportu Allegro i Ceneo, TXT/JSON oraz trybu AI compact / pełnych opisów.
