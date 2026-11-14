import unittest
from algorithms import merge_sort, binary_search

class TestAlgorithms(unittest.TestCase):
    def test_merge_sort(self):
        self.assertEqual(merge_sort([3, 1, 4, 1, 5, 9, 2, 6, 5]), [1, 1, 2, 3, 4, 5, 5, 6, 9])
        self.assertEqual(merge_sort([10, 20, 30]), [10, 20, 30])
        self.assertEqual(merge_sort([]), [])
        self.assertEqual(merge_sort([1]), [1])
        self.assertEqual(merge_sort([5, 4, 3, 2, 1]), [1, 2, 3, 4, 5])

    def test_binary_search(self):
        arr = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        self.assertEqual(binary_search(arr, 4), 3)
        self.assertEqual(binary_search(arr, 1), 0)
        self.assertEqual(binary_search(arr, 9), 8)
        self.assertEqual(binary_search(arr, 0), -1)
        self.assertEqual(binary_search(arr, 10), -1)
        self.assertEqual(binary_search([], 1), -1)

if __name__ == '__main__':
    unittest.main()