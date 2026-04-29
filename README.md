# CS Research Concept Explorer

A thing I've always run thought about when reading research papers is that they rarely tell you *why* someone made a particular decision, or where the idea even came from. You're handed a fully-formed solution with citations, but the intellectual journey, the tough parts, the dead ends, the incremental refinements, the moment someone realized the old approach was fundamentally broken is invisible.

I built this tool for my own personal learning to surface that history. You type in a concept like "type inference" or "consensus algorithms" and it searches across decades of papers from the top academic venues in programming languages, distributed systems, formal methods, and automata theory. Rather than just querying one AI, it runs Claude, Gemini, and Groq in parallel. Each model has different recall and different blind spots and then synthesizes all results into a single coherent timeline.

What you get back is a narrative explaining how the idea evolved, and a chronological set of papers with a short explanation of what each one actually *contributed* to that evolution, not just what it did. The goal is to help you get the intellectual context that as of today can only be developed by reading sufficient papers in great depth.

**In the next version**, I will try to generate more information on what is the single core research idea of each paper with an example, and also add the ability to search books. I believe it is important to understand a paper or concept intuitively before diving into the details.

I still use AI engines to do this search and invoke their APIs so you must proof check the results for now — this is intended to be a starter. Over time, I will ensure the results are more or less accurate.

**Live site:** https://rupashreeh.github.io/cs_research_explorer/

---

*Note: The current code has been written with the help of Claude.*
