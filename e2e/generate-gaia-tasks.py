#!/usr/bin/env python3
"""
Generate 100 GAIA-style questions following the published GAIA format.
GAIA (General AI Assistants) benchmark features real-world questions requiring
multi-step reasoning, tool use, and unambiguous short answers.

Since the official GAIA dataset is gated on HuggingFace and network is restricted,
these questions follow the SAME format, difficulty distribution, and task patterns
described in the GAIA paper (arXiv:2311.12983).

Level 1 (easy, ~1-3 steps): 40 questions
Level 2 (medium, ~3-5 steps): 35 questions
Level 3 (hard, ~5+ steps): 25 questions

Output: /workspace/micro-agent/e2e/bench-fixtures/gaia-100.json
"""
import json, os

OUT = "/workspace/micro-agent/e2e/bench-fixtures/gaia-100.json"

# Create additional fixture files for GAIA questions
FIXTURES = "/workspace/micro-agent/e2e/bench-fixtures/gaia-data"
os.makedirs(FIXTURES, exist_ok=True)

# Fixture: A research paper abstract
with open(f"{FIXTURES}/paper-abstract.txt", "w") as f:
    f.write("""Title: Attention Is All You Need
Authors: Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Lukasz Kaiser, Illia Polosukhin
Year: 2017
Venue: NeurIPS
Citations: 130000+
Abstract: The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.
Number of authors: 8
Pages: 15
""")

# Fixture: A company financial report
with open(f"{FIXTURES}/financial-report.csv", "w") as f:
    f.write("""quarter,revenue,expenses,profit,employees
Q1-2024,1500000,1200000,300000,45
Q2-2024,1800000,1300000,500000,52
Q3-2024,2100000,1400000,700000,58
Q4-2024,2500000,1600000,900000,65
Q1-2025,2800000,1700000,1100000,72
Q2-2025,3200000,1900000,1300000,80
""")

# Fixture: A list of countries with data
with open(f"{FIXTURES}/countries.json", "w") as f:
    json.dump([
        {"name": "China", "capital": "Beijing", "population": 1412000000, "area_km2": 9596961, "gdp_trillion": 17.7, "continent": "Asia", "independence_year": 1949},
        {"name": "India", "capital": "New Delhi", "population": 1408000000, "area_km2": 3287263, "gdp_trillion": 3.7, "continent": "Asia", "independence_year": 1947},
        {"name": "United States", "capital": "Washington D.C.", "population": 333000000, "area_km2": 9833517, "gdp_trillion": 25.5, "continent": "North America", "independence_year": 1776},
        {"name": "Indonesia", "capital": "Jakarta", "population": 273500000, "area_km2": 1904569, "gdp_trillion": 1.3, "continent": "Asia", "independence_year": 1945},
        {"name": "Pakistan", "capital": "Islamabad", "population": 235800000, "area_km2": 881913, "gdp_trillion": 0.4, "continent": "Asia", "independence_year": 1947},
        {"name": "Brazil", "capital": "Brasilia", "population": 215300000, "area_km2": 8515767, "gdp_trillion": 1.9, "continent": "South America", "independence_year": 1822},
        {"name": "Nigeria", "capital": "Abuja", "population": 218500000, "area_km2": 923768, "gdp_trillion": 0.5, "continent": "Africa", "independence_year": 1960},
        {"name": "Bangladesh", "capital": "Dhaka", "population": 171200000, "area_km2": 147570, "gdp_trillion": 0.4, "continent": "Asia", "independence_year": 1971},
        {"name": "Russia", "capital": "Moscow", "population": 144400000, "area_km2": 17098242, "gdp_trillion": 2.2, "continent": "Europe/Asia", "independence_year": 1991},
        {"name": "Mexico", "capital": "Mexico City", "population": 128500000, "area_km2": 1964375, "gdp_trillion": 1.4, "continent": "North America", "independence_year": 1821},
        {"name": "Japan", "capital": "Tokyo", "population": 125700000, "area_km2": 377975, "gdp_trillion": 4.2, "continent": "Asia", "independence_year": 660},
        {"name": "Ethiopia", "capital": "Addis Ababa", "population": 123400000, "area_km2": 1104300, "gdp_trillion": 0.1, "continent": "Africa", "independence_year": -980},
        {"name": "Philippines", "capital": "Manila", "population": 115600000, "area_km2": 300000, "gdp_trillion": 0.4, "continent": "Asia", "independence_year": 1946},
        {"name": "Egypt", "capital": "Cairo", "population": 109300000, "area_km2": 1001450, "gdp_trillion": 0.5, "continent": "Africa", "independence_year": 1922},
        {"name": "Vietnam", "capital": "Hanoi", "population": 98200000, "area_km2": 331212, "gdp_trillion": 0.4, "continent": "Asia", "independence_year": 1945},
        {"name": "Germany", "capital": "Berlin", "population": 83200000, "area_km2": 357022, "gdp_trillion": 4.1, "continent": "Europe", "independence_year": 1871},
        {"name": "France", "capital": "Paris", "population": 67800000, "area_km2": 551695, "gdp_trillion": 2.9, "continent": "Europe", "independence_year": 843},
        {"name": "United Kingdom", "capital": "London", "population": 67500000, "area_km2": 243610, "gdp_trillion": 3.1, "continent": "Europe", "independence_year": 1707},
        {"name": "Italy", "capital": "Rome", "population": 58900000, "area_km2": 301340, "gdp_trillion": 2.1, "continent": "Europe", "independence_year": 1861},
        {"name": "South Korea", "capital": "Seoul", "population": 51700000, "area_km2": 100210, "gdp_trillion": 1.7, "continent": "Asia", "independence_year": 1948},
    ], f, indent=2)

# Fixture: A log file
with open(f"{FIXTURES}/server-logs.txt", "w") as f:
    f.write("""2024-01-15 09:00:12 INFO  Server started on port 8080
2024-01-15 09:00:15 INFO  Database connection established
2024-01-15 09:01:23 WARN  Slow query detected: 1.2s
2024-01-15 09:02:45 ERROR Failed login attempt from 192.168.1.100
2024-01-15 09:03:12 ERROR Failed login attempt from 192.168.1.100
2024-01-15 09:03:45 ERROR Failed login attempt from 192.168.1.100
2024-01-15 09:04:01 INFO  User 'admin' logged in successfully
2024-01-15 09:05:33 WARN  High memory usage: 82%
2024-01-15 09:06:12 ERROR Database connection timeout
2024-01-15 09:06:45 INFO  Database reconnection successful
2024-01-15 09:07:23 WARN  Slow query detected: 2.1s
2024-01-15 09:08:01 ERROR File not found: /data/config.yml
2024-01-15 09:09:12 INFO  Backup completed: 1.2GB
2024-01-15 09:10:33 ERROR Failed login attempt from 10.0.0.50
2024-01-15 09:11:01 WARN  High CPU usage: 91%
2024-01-15 09:12:23 ERROR API rate limit exceeded for key: abc123
2024-01-15 09:13:12 INFO  Cache cleared: 256MB
2024-01-15 09:14:33 ERROR Connection refused: 203.0.113.5
2024-01-15 09:15:01 INFO  Health check passed
2024-01-15 09:16:12 WARN  Disk space low: 15% remaining
""")

# Fixture: A product inventory
with open(f"{FIXTURES}/inventory.json", "w") as f:
    json.dump([
        {"id": "P001", "name": "Laptop Pro 15", "category": "electronics", "price": 1299.99, "stock": 45, "supplier": "TechCorp", "rating": 4.5},
        {"id": "P002", "name": "Wireless Mouse", "category": "electronics", "price": 29.99, "stock": 200, "supplier": "TechCorp", "rating": 4.2},
        {"id": "P003", "name": "USB-C Cable", "category": "electronics", "price": 12.99, "stock": 500, "supplier": "CableWorld", "rating": 4.0},
        {"id": "P004", "name": "Coffee Mug", "category": "kitchen", "price": 14.99, "stock": 150, "supplier": "HomeGoods", "rating": 4.7},
        {"id": "P005", "name": "Notebook A5", "category": "stationery", "price": 5.99, "stock": 300, "supplier": "PaperPlus", "rating": 4.3},
        {"id": "P006", "name": "Desk Lamp LED", "category": "electronics", "price": 39.99, "stock": 80, "supplier": "TechCorp", "rating": 4.6},
        {"id": "P007", "name": "Water Bottle", "category": "kitchen", "price": 19.99, "stock": 120, "supplier": "HomeGoods", "rating": 4.4},
        {"id": "P008", "name": "Mechanical Keyboard", "category": "electronics", "price": 89.99, "stock": 60, "supplier": "TechCorp", "rating": 4.8},
        {"id": "P009", "name": "Pen Set (10pk)", "category": "stationery", "price": 8.99, "stock": 250, "supplier": "PaperPlus", "rating": 4.1},
        {"id": "P010", "name": "Monitor 27\"", "category": "electronics", "price": 349.99, "stock": 30, "supplier": "TechCorp", "rating": 4.5},
        {"id": "P011", "name": "Desk Chair", "category": "furniture", "price": 249.99, "stock": 25, "supplier": "FurniturePro", "rating": 4.3},
        {"id": "P012", "name": "Webcam HD", "category": "electronics", "price": 59.99, "stock": 100, "supplier": "TechCorp", "rating": 4.0},
        {"id": "P013", "name": "Sticky Notes", "category": "stationery", "price": 3.99, "stock": 400, "supplier": "PaperPlus", "rating": 4.5},
        {"id": "P014", "name": "Plant Pot", "category": "home", "price": 15.99, "stock": 90, "supplier": "HomeGoods", "rating": 4.2},
        {"id": "P015", "name": "USB Hub", "category": "electronics", "price": 24.99, "stock": 75, "supplier": "TechCorp", "rating": 4.1},
    ], f, indent=2)

# Fixture: A book list
with open(f"{FIXTURES}/books.txt", "w") as f:
    f.write("""1. "The Great Gatsby" by F. Scott Fitzgerald (1925) - 180 pages - Fiction
2. "1984" by George Orwell (1949) - 328 pages - Fiction
3. "To Kill a Mockingbird" by Harper Lee (1960) - 281 pages - Fiction
4. "Pride and Prejudice" by Jane Austen (1813) - 432 pages - Fiction
5. "The Catcher in the Rye" by J.D. Salinger (1951) - 277 pages - Fiction
6. "The Hobbit" by J.R.R. Tolkien (1937) - 310 pages - Fantasy
7. "Brave New World" by Aldous Huxley (1932) - 311 pages - Fiction
8. "The Lord of the Rings" by J.R.R. Tolkien (1954) - 1178 pages - Fantasy
9. "Crime and Punishment" by Fyodor Dostoevsky (1866) - 671 pages - Fiction
10. "The Odyssey" by Homer (800 BC) - 541 pages - Epic
11. "Frankenstein" by Mary Shelley (1818) - 280 pages - Fiction
12. "Moby Dick" by Herman Melville (1851) - 635 pages - Fiction
13. "War and Peace" by Leo Tolstoy (1869) - 1225 pages - Fiction
14. "Hamlet" by William Shakespeare (1603) - 342 pages - Drama
15. "The Divine Comedy" by Dante Alighieri (1320) - 798 pages - Epic
""")

questions = []

# === LEVEL 1 (40 questions, ~1-3 steps) ===
L1 = [
    ("G-L1-001", "Read the file 'e2e/bench-fixtures/gaia-data/paper-abstract.txt' and tell me the year this paper was published.", "2017", "read_file → extract year"),
    ("G-L1-002", "Read the file 'e2e/bench-fixtures/gaia-data/paper-abstract.txt' and tell me how many authors are listed.", "8", "read_file → count authors"),
    ("G-L1-003", "Read the file 'e2e/bench-fixtures/gaia-data/paper-abstract.txt' and tell me the title of the paper.", "Attention Is All You Need", "read_file → extract title"),
    ("G-L1-004", "Read the file 'e2e/bench-fixtures/gaia-data/paper-abstract.txt' and tell me the venue where it was published.", "NeurIPS", "read_file → extract venue"),
    ("G-L1-005", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me the capital of Brazil.", "Brasilia", "read_file → extract field"),
    ("G-L1-006", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me the capital of Japan.", "Tokyo", "read_file → extract field"),
    ("G-L1-007", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me the population of China.", "1412000000", "read_file → extract field"),
    ("G-L1-008", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me which continent Germany is in.", "Europe", "read_file → extract field"),
    ("G-L1-009", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me who wrote '1984'.", "George Orwell", "read_file → extract author"),
    ("G-L1-010", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me the publication year of 'The Hobbit'.", "1937", "read_file → extract year"),
    ("G-L1-011", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me how many pages 'War and Peace' has.", "1225", "read_file → extract pages"),
    ("G-L1-012", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me the genre of 'The Lord of the Rings'.", "Fantasy", "read_file → extract genre"),
    ("G-L1-013", "Read the file 'e2e/bench-fixtures/gaia-data/financial-report.csv' and tell me the revenue in Q1-2024.", "1500000", "read_file → extract revenue"),
    ("G-L1-014", "Read the file 'e2e/bench-fixtures/gaia-data/financial-report.csv' and tell me the number of employees in Q4-2024.", "65", "read_file → extract employees"),
    ("G-L1-015", "Read the file 'e2e/bench-fixtures/gaia-data/financial-report.csv' and tell me the profit in Q2-2025.", "1300000", "read_file → extract profit"),
    ("G-L1-016", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me the price of 'Mechanical Keyboard'.", "89.99", "read_file → extract price"),
    ("G-L1-017", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me the stock count of 'USB-C Cable'.", "500", "read_file → extract stock"),
    ("G-L1-018", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me the supplier of 'Desk Chair'.", "FurniturePro", "read_file → extract supplier"),
    ("G-L1-019", "Read the file 'e2e/bench-fixtures/gaia-data/server-logs.txt' and tell me how many ERROR entries there are.", "7", "read_file → count ERROR"),
    ("G-L1-020", "Read the file 'e2e/bench-fixtures/gaia-data/server-logs.txt' and tell me how many WARN entries there are.", "5", "read_file → count WARN"),
    ("G-L1-021", "Read the file 'e2e/bench-fixtures/gaia-data/server-logs.txt' and tell me how many INFO entries there are.", "8", "read_file → count INFO"),
    ("G-L1-022", "Read the file 'e2e/bench-fixtures/gaia-data/server-logs.txt' and tell me what port the server started on.", "8080", "read_file → extract port"),
    ("G-L1-023", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me how many countries are listed.", "20", "read_file → count entries"),
    ("G-L1-024", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me the GDP of the United States.", "25.5", "read_file → extract GDP"),
    ("G-L1-025", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me the area of Russia in km2.", "17098242", "read_file → extract area"),
    ("G-L1-026", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me how many books are listed.", "15", "read_file → count entries"),
    ("G-L1-027", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me the oldest book's publication year.", "800 BC", "read_file → find min year"),
    ("G-L1-028", "Read the file 'e2e/bench-fixtures/gaia-data/books.txt' and tell me the longest book title.", "The Lord of the Rings", "read_file → find longest title"),
    ("G-L1-029", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me how many products are in the 'electronics' category.", "8", "read_file → count by category"),
    ("G-L1-030", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me the highest rated product.", "Mechanical Keyboard", "read_file → find max rating"),
    ("G-L1-031", "Read the file 'e2e/bench-fixtures/gaia-data/financial-report.csv' and tell me which quarter had the highest revenue.", "Q2-2025", "read_file → find max revenue"),
    ("G-L1-032", "Read the file 'e2e/bench-fixtures/gaia-data/financial-report.csv' and tell me which quarter had the lowest profit.", "Q1-2024", "read_file → find min profit"),
    ("G-L1-033", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me which country has the largest population.", "China", "read_file → find max population"),
    ("G-L1-034", "Read the file 'e2e/bench-fixtures/gaia-data/countries.json' and tell me which country has the smallest area.", "Bangladesh", "read_file → find min area"),
    ("G-L1-035", "Read the file 'e2e/bench-fixtures/gaia-data/server-logs.txt' and tell me the first timestamp in the log.", "2024-01-15 09:00:12", "read_file → extract first timestamp"),
    ("G-L1-036", "Read the file 'e2e/bench-fixtures/gaia-data/server-logs.txt' and tell me the last timestamp in the log.", "2024-01-15 09:16:12", "read_file → extract last timestamp"),
    ("G-L1-037", "Read the file 'e2e/bench-fixtures/gaia-data/paper-abstract.txt' and tell me how many citations the paper has (number only).", "130000", "read_file → extract citations"),
    ("G-L1-038", "Read the file 'e2e/bench-fixtures/gaia-data/paper-abstract.txt' and tell me how many pages the paper has.", "15", "read_file → extract pages"),
    ("G-L1-039", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me the cheapest product's name.", "Sticky Notes", "read_file → find min price"),
    ("G-L1-040", "Read the file 'e2e/bench-fixtures/gaia-data/inventory.json' and tell me the most expensive product's name.", "Laptop Pro 15", "read_file → find max price"),
]

# === LEVEL 2 (35 questions, ~3-5 steps) ===
L2 = [
    ("G-L2-001", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Calculate the total population of all Asian countries. Reply with ONLY the number.", "4554900000", "read_file → filter Asia → sum population"),
    ("G-L2-002", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Calculate the total GDP of all European countries. Reply with ONLY the number.", "12.1", "read_file → filter Europe → sum GDP"),
    ("G-L2-003", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Find the country with the highest population density (population / area). Reply with ONLY the country name.", "Bangladesh", "read_file → compute density → find max"),
    ("G-L2-004", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Calculate the average GDP of all countries. Reply with ONLY the number rounded to 2 decimal places.", "3.13", "read_file → avg GDP"),
    ("G-L2-005", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. How many countries gained independence after 1900? Reply with ONLY the number.", "16", "read_file → filter year > 1900 → count"),
    ("G-L2-006", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Calculate the total revenue across all quarters. Reply with ONLY the number.", "13900000", "read_file → sum revenue"),
    ("G-L2-007", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Calculate the total profit across all quarters. Reply with ONLY the number.", "4800000", "read_file → sum profit"),
    ("G-L2-008", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Calculate the average expenses. Reply with ONLY the number rounded to nearest integer.", "1500000", "read_file → avg expenses"),
    ("G-L2-009", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. What is the profit margin (profit/revenue) for Q4-2024? Reply with ONLY the percentage rounded to 1 decimal place.", "36.0", "read_file → compute margin"),
    ("G-L2-010", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. What is the revenue growth rate from Q1-2024 to Q2-2025? Reply with ONLY the percentage rounded to 1 decimal place.", "113.3", "read_file → compute growth rate"),
    ("G-L2-011", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. Calculate the total number of pages across all books. Reply with ONLY the number.", "7611", "read_file → sum pages"),
    ("G-L2-012", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. What is the average number of pages per book? Reply with ONLY the number rounded to nearest integer.", "507", "read_file → avg pages"),
    ("G-L2-013", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. How many books were published in the 20th century (1900-1999)? Reply with ONLY the number.", "8", "read_file → filter century → count"),
    ("G-L2-014", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. Which author wrote the most books in this list? Reply with ONLY the author name.", "J.R.R. Tolkien", "read_file → count per author → find max"),
    ("G-L2-015", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. What is the difference in pages between the longest and shortest book? Reply with ONLY the number.", "1045", "read_file → max - min pages"),
    ("G-L2-016", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. Calculate the total value of all inventory (price * stock for each product). Reply with ONLY the number.", "180738.5", "read_file → compute total value"),
    ("G-L2-017", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. What is the average price of electronics products? Reply with ONLY the number rounded to 2 decimal places.", "247.79", "read_file → filter electronics → avg price"),
    ("G-L2-018", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. Which supplier has the most products? Reply with ONLY the supplier name.", "TechCorp", "read_file → count per supplier → find max"),
    ("G-L2-019", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. Calculate the total stock across all products. Reply with ONLY the number.", "2425", "read_file → sum stock"),
    ("G-L2-020", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. What is the average rating of all products? Reply with ONLY the number rounded to 2 decimal places.", "4.35", "read_file → avg rating"),
    ("G-L2-021", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. How many unique IP addresses appear in ERROR entries? Reply with ONLY the number.", "4", "read_file → filter ERROR → extract IPs → count unique"),
    ("G-L2-022", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. What is the time span between the first and last log entry in minutes? Reply with ONLY the number.", "16", "read_file → parse timestamps → diff"),
    ("G-L2-023", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. How many failed login attempts were there? Reply with ONLY the number.", "4", "read_file → filter failed login → count"),
    ("G-L2-024", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. What was the peak memory usage percentage mentioned? Reply with ONLY the number.", "82", "read_file → extract memory usage → find max"),
    ("G-L2-025", "Read 'e2e/bench-fixtures/gaia-data/paper-abstract.txt'. Count the number of words in the abstract. Reply with ONLY the number.", "62", "read_file → count words"),
    ("G-L2-026", "Read 'e2e/bench-fixtures/gaia-data/countries.json' and 'e2e/bench-fixtures/gaia-data/books.txt'. How many countries in the JSON have a name that starts with the same letter as any author's last name? Reply with ONLY the number.", "5", "read 2 files → cross-reference"),
    ("G-L2-027", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv' and 'e2e/bench-fixtures/gaia-data/inventory.json'. Is the total revenue (all quarters) greater than the total inventory value? Reply with Yes or No.", "Yes", "read 2 files → compare sums"),
    ("G-L2-028", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. List all countries in Africa. How many are there? Reply with ONLY the number.", "2", "read_file → filter Africa → count"),
    ("G-L2-029", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. What percentage of countries are in Asia? Reply with ONLY the percentage rounded to nearest integer.", "55", "read_file → count Asia / total * 100"),
    ("G-L2-030", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. What is the total stock value (price * stock) of all TechCorp products? Reply with ONLY the number.", "100348.55", "read_file → filter TechCorp → sum price*stock"),
    ("G-L2-031", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. What is the median number of pages? Reply with ONLY the number.", "311", "read_file → sort → median"),
    ("G-L2-032", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. What is the ratio of ERROR to INFO entries? Reply with ONLY the ratio as a decimal rounded to 2 places.", "0.88", "read_file → count ERROR/INFO"),
    ("G-L2-033", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. What is the total area of all North American countries? Reply with ONLY the number.", "11797892", "read_file → filter N. America → sum area"),
    ("G-L2-034", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. How many quarters had profit exceeding 500000? Reply with ONLY the number.", "5", "read_file → filter profit > 500K → count"),
    ("G-L2-035", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. What is the price range (max - min) across all products? Reply with ONLY the number rounded to 2 decimal places.", "1296.0", "read_file → max price - min price"),
]

# === LEVEL 3 (25 questions, ~5+ steps) ===
L3 = [
    ("G-L3-001", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Calculate the population-weighted average GDP per capita across all countries. Reply with ONLY the number (integer).", "15206", "read_file → compute GDP*pop → sum / total pop"),
    ("G-L3-002", "Read 'e2e/bench-fixtures/gaia-data/countries.json' and 'e2e/bench-fixtures/gaia-data/financial-report.csv'. If the total revenue were distributed equally among the populations of all countries, how much would each person get? Reply with ONLY the number rounded to nearest cent.", "0.00", "read 2 files → revenue / total population"),
    ("G-L3-003", "Read 'e2e/bench-fixtures/gaia-data/books.txt', 'e2e/bench-fixtures/gaia-data/countries.json', and 'e2e/bench-fixtures/gaia-data/inventory.json'. How many total items (books + countries + products) are there? Reply with ONLY the number.", "50", "read 3 files → sum counts"),
    ("G-L3-004", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. Group products by supplier. For each supplier, calculate total stock value. Which supplier has the highest total stock value? Reply with ONLY the supplier name.", "TechCorp", "read_file → group → aggregate → find max"),
    ("G-L3-005", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. Group products by category. For each category, calculate average rating. Which category has the highest average rating? Reply with ONLY the category name.", "furniture", "read_file → group → aggregate → find max"),
    ("G-L3-006", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Calculate the quarter-over-quarter revenue growth rate for each quarter. What is the highest growth rate? Reply with ONLY the percentage rounded to 1 decimal place.", "25.0", "read_file → compute sequential growth rates → find max"),
    ("G-L3-007", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. Create a summary: count entries by severity level (INFO, WARN, ERROR). What is the total number of entries? Reply with ONLY the number.", "20", "read_file → count by level → sum"),
    ("G-L3-008", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. For each continent, find the country with the largest population. How many continents are represented? Reply with ONLY the number.", "5", "read_file → group by continent → find max per group → count groups"),
    ("G-L3-009", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. Sort books by publication year (oldest first). What is the 5th oldest book? Reply with ONLY the book title.", "The Divine Comedy", "read_file → sort by year → get 5th"),
    ("G-L3-010", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Calculate the correlation between population and area. Is it positive or negative? Reply with ONLY 'positive' or 'negative'.", "positive", "read_file → compute correlation"),
    ("G-L3-011", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. Find all products with rating above 4.3. Calculate their average price. Reply with ONLY the number rounded to 2 decimal places.", "150.87", "read_file → filter rating > 4.3 → avg price"),
    ("G-L3-012", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Calculate the compound monthly growth rate of revenue (assuming each quarter = 3 months). Reply with ONLY the percentage rounded to 2 decimal places.", "13.39", "read_file → compute CAGR → monthly"),
    ("G-L3-013", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. Group books by genre. Which genre has the highest average page count? Reply with ONLY the genre name.", "Epic", "read_file → group by genre → avg pages → find max"),
    ("G-L3-014", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. Extract all timestamps from ERROR entries. What is the average time between consecutive ERROR entries in seconds? Reply with ONLY the number rounded to nearest integer.", "100", "read_file → filter ERROR → parse timestamps → avg diff"),
    ("G-L3-015", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Find the top 3 countries by GDP. Calculate their combined GDP. Reply with ONLY the number.", "47.4", "read_file → sort by GDP → top 3 → sum"),
    ("G-L3-016", "Read 'e2e/bench-fixtures/gaia-data/inventory.json' and 'e2e/bench-fixtures/gaia-data/financial-report.csv'. If you sold all inventory at list price, what percentage of Q1-2024 revenue would that represent? Reply with ONLY the percentage rounded to 1 decimal place.", "12.0", "read 2 files → inventory value / Q1 revenue * 100"),
    ("G-L3-017", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. For countries that gained independence after 1945, calculate the average population. Reply with ONLY the number (integer).", "315500000", "read_file → filter year > 1945 → avg pop"),
    ("G-L3-018", "Read 'e2e/bench-fixtures/gaia-data/books.txt'. Find the author who wrote the book with the most pages. Then find that author's other book(s) in the list. What is the total page count of all their books? Reply with ONLY the number.", "1488", "read_file → find max pages → find author → sum their pages"),
    ("G-L3-019", "Read 'e2e/bench-fixtures/gaia-data/server-logs.txt'. What is the most common hour (from timestamps) for log entries? Reply with ONLY the hour number (e.g., 9).", "9", "read_file → parse timestamps → count by hour → find max"),
    ("G-L3-020", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Calculate the linear regression slope of revenue over quarters (Q1-2024=1, Q2-2024=2, etc.). Is revenue increasing or decreasing? Reply with ONLY 'increasing' or 'decreasing'.", "increasing", "read_file → linear regression → sign of slope"),
    ("G-L3-021", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Calculate the Gini coefficient of population distribution across all countries. Reply with ONLY the number rounded to 3 decimal places.", "0.498", "read_file → compute Gini coefficient"),
    ("G-L3-022", "Read 'e2e/bench-fixtures/gaia-data/inventory.json'. For each category, find the product with the highest stock. How many categories have a product with stock > 100? Reply with ONLY the number.", "4", "read_file → group → max stock per group → count > 100"),
    ("G-L3-023", "Read 'e2e/bench-fixtures/gaia-data/countries.json'. Rank countries by area (largest first). What is the rank of the United States? Reply with ONLY the number.", "3", "read_file → sort by area → find US rank"),
    ("G-L3-024", "Read 'e2e/bench-fixtures/gaia-data/books.txt' and 'e2e/bench-fixtures/gaia-data/inventory.json'. How many book titles contain a word that also appears in a product name? Reply with ONLY the number.", "0", "read 2 files → tokenize → intersect → count"),
    ("G-L3-025", "Read 'e2e/bench-fixtures/gaia-data/financial-report.csv'. Predict the revenue for Q3-2025 using linear extrapolation from the existing data. Reply with ONLY the number (integer).", "3600000", "read_file → linear regression → extrapolate"),
]

for q_id, prompt, expected, pattern in L1:
    questions.append({"id": q_id, "level": 1, "prompt": prompt, "expected": expected, "tool_chain": pattern, "source": "GAIA-style (constructed)"})
for q_id, prompt, expected, pattern in L2:
    questions.append({"id": q_id, "level": 2, "prompt": prompt, "expected": expected, "tool_chain": pattern, "source": "GAIA-style (constructed)"})
for q_id, prompt, expected, pattern in L3:
    questions.append({"id": q_id, "level": 3, "prompt": prompt, "expected": expected, "tool_chain": pattern, "source": "GAIA-style (constructed)"})

with open(OUT, "w") as f:
    json.dump(questions, f, indent=2, ensure_ascii=False)

print(f"Generated {len(questions)} GAIA-style questions")
levels = {}
for q in questions:
    levels[q["level"]] = levels.get(q["level"], 0) + 1
for lv in sorted(levels):
    print(f"  Level {lv}: {levels[lv]} questions")
print(f"Saved to: {OUT}")
