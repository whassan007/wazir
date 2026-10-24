#include <iostream>
#include <vector>
#include <algorithm>

// Function to partition the array using the Lomuto partition scheme
int partition(std::vector<int>& arr, int low, int high) {
    int pivot = arr[high]; // Choosing the last element as pivot
    int i = (low - 1);       // Index of smaller element

    for (int j = low; j <= high - 1; j++) {
        // If current element is smaller than or equal to pivot
        if (arr[j] <= pivot) {
            i++;
            std::swap(arr[i], arr[j]);
        }
    }
    std::swap(arr[i + 1], arr[high]);
    return (i + 1);
}

// The main function that implements QuickSort
void quickSort(std::vector<int>& arr, int low, int high) {
    if (low < high) {
        // pi is partitioning index, arr[pi] is now at right place
        int pi = partition(arr, low, high);

        // Separately sort elements before partition and after partition
        quickSort(arr, low, pi - 1);
        quickSort(arr, pi + 1, high);
    }
}

int main() {
    // Initialize an array of 10 unsorted integers
    std::vector<int> data = {34, 7, 23, 32, 5, 62, 32, 12, 45, 1};

    std::cout << "Original array: ";
    for (int x : data) {
        std::cout << x << " ";
    }
    std::cout << std::endl;

    // Sort the array
    quickSort(data, 0, data.size() - 1);

    std::cout << "Sorted array:   ";
    for (int x : data) {
        std::cout << x << " ";
    }
    std::cout << std::endl;

    return 0;
}
